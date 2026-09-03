// Unit tests for lib/ov-delete.mjs: credential resolution, DELETE semantics
// (200 / 404 / retry-queue), pending queue replay, and header fields.
// All IO is injected: fetchImpl / readFile / store — nothing touches the disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deleteOpenVikingSession,
  flushPendingOvDeletes,
  pushOvPendingDelete,
  resolveOvCredentials,
  OV_SESSION_ID_PREFIX,
} from "../lib/ov-delete.mjs";

function memoryStore(initial = []) {
  let entries = [...initial];
  return {
    load: async () => [...entries],
    save: async (next) => {
      entries = [...next];
    },
    entries: () => entries,
  };
}

const noConf = () => null; // simulate missing ovcli.conf

function fakeFetch(responses = []) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url, init: { ...init, headers: { ...init.headers } } });
    const r = responses.length === 1 ? responses[0] : responses.shift();
    if (typeof r === "number") return { ok: r >= 200 && r < 300, status: r };
    if (r instanceof Error) throw r;
    return r ?? { ok: true, status: 200 };
  };
  impl.calls = calls;
  return impl;
}

const envWithCreds = (over = {}) => ({
  OPENVIKING_API_KEY: "k123",
  OPENVIKING_ACCOUNT: "default",
  OPENVIKING_USER: "dsh-import",
  ...over,
});

test("resolveOvCredentials: env wins", () => {
  const c = resolveOvCredentials(envWithCreds({ OPENVIKING_URL: "http://x" }), null);
  assert.equal(c.url, "http://x");
  assert.equal(c.apiKey, "k123");
  assert.equal(c.account, "default");
  assert.equal(c.user, "dsh-import");
});

test("resolveOvCredentials: falls back to ovcli.conf, url defaults locally", () => {
  const readFile = () =>
    JSON.stringify({ api_key: "cfgf", account: "a", user: "u" });
  const c = resolveOvCredentials({}, readFile);
  assert.equal(c.apiKey, "cfgf");
  assert.equal(c.url, "http://127.0.0.1:1933");
});

test("resolveOvCredentials: no creds -> null", () => {
  assert.equal(resolveOvCredentials({}, null), null);
});

test("delete: 200 -> deleted, id prefixed dsh-, headers correct", async () => {
  const fetchImpl = fakeFetch([{ ok: true, status: 200 }]);
  const store = memoryStore();
  const r = await deleteOpenVikingSession({
    sessionId: "session-abc",
    env: envWithCreds(),
    fetchImpl,
    store,
    retryDelayMs: 0,
  });
  assert.equal(r.status, "deleted");
  assert.equal(fetchImpl.calls.length, 1);
  assert.ok(fetchImpl.calls[0].url.endsWith(`/api/v1/sessions/${OV_SESSION_ID_PREFIX}session-abc`));
  const h = fetchImpl.calls[0].init.headers;
  assert.equal(h.Authorization, "Bearer k123");
  assert.equal(h["X-OpenViking-Account"], "default");
  assert.equal(h["X-OpenViking-User"], "dsh-import");
  assert.equal(fetchImpl.calls[0].init.method, "DELETE");
});

test("delete: 404 -> treated as deleted", async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 404 }]);
  const store = memoryStore();
  const r = await deleteOpenVikingSession({
    sessionId: "s1",
    env: envWithCreds(),
    fetchImpl,
    store,
    retryDelayMs: 0,
  });
  assert.equal(r.status, "deleted");
  assert.equal(store.entries().length, 0);
});

test("delete: 500 -> retries once, then queues", async () => {
  const fetchImpl = fakeFetch([{ ok: false, status: 500 }, { ok: false, status: 500 }]);
  const store = memoryStore();
  const r = await deleteOpenVikingSession({
    sessionId: "s2",
    env: envWithCreds(),
    fetchImpl,
    store,
    retryDelayMs: 0,
  });
  assert.equal(r.status, "queued");
  assert.equal(fetchImpl.calls.length, 2);
  assert.deepEqual(store.entries().map((e) => e.sessionId), [`dsh-s2`]);
});

test("delete: network error -> queues after retry", async () => {
  const fetchImpl = fakeFetch([new Error("ECONNREFUSED"), new Error("ECONNREFUSED")]);
  const store = memoryStore();
  const r = await deleteOpenVikingSession({
    sessionId: "s3",
    env: envWithCreds(),
    fetchImpl,
    store,
    retryDelayMs: 0,
  });
  assert.equal(r.status, "queued");
  assert.equal(fetchImpl.calls.length, 2);
});

test("delete: no credentials -> skipped, zero calls, zero queue entries", async () => {
  const fetchImpl = fakeFetch([]);
  const store = memoryStore();
  const r = await deleteOpenVikingSession({
    sessionId: "s4",
    env: {},
    readFile: noConf,
    fetchImpl,
    store,
  });
  assert.equal(r.status, "skipped");
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(store.entries().length, 0);
});

test("pushOvPendingDelete: idempotent per session id", async () => {
  const store = memoryStore();
  await pushOvPendingDelete({ sessionId: "dsh-a", store });
  await pushOvPendingDelete({ sessionId: "dsh-a", store });
  await pushOvPendingDelete({ sessionId: "dsh-b", store });
  assert.deepEqual(store.entries().map((e) => e.sessionId), ["dsh-a", "dsh-b"]);
});

test("flush: success and 404 remove entries, failure keeps with attempts+1", async () => {
  const store = memoryStore([
    { sessionId: "dsh-ok", attempts: 0 },
    { sessionId: "dsh-missing", attempts: 0 },
    { sessionId: "dsh-fail", attempts: 0 },
  ]);
  const fetchImpl = fakeFetch([
    { ok: true, status: 200 },
    { ok: false, status: 404 },
    { ok: false, status: 500 },
  ]);
  const flushed = await flushPendingOvDeletes({ env: envWithCreds(), fetchImpl, store });
  assert.equal(flushed, 2);
  const left = store.entries();
  assert.equal(left.length, 1);
  assert.equal(left[0].sessionId, "dsh-fail");
  assert.equal(left[0].attempts, 1);
});

test("flush: no credentials -> no-op, queue untouched", async () => {
  const store = memoryStore([{ sessionId: "dsh-x", attempts: 0 }]);
  const fetchImpl = fakeFetch([]);
  const flushed = await flushPendingOvDeletes({ env: {}, readFile: noConf, fetchImpl, store });
  assert.equal(flushed, 0);
  assert.equal(store.entries().length, 1);
  assert.equal(fetchImpl.calls.length, 0);
});

test("flush: empty queue -> 0 without fetch", async () => {
  const store = memoryStore([]);
  const fetchImpl = fakeFetch([]);
  const flushed = await flushPendingOvDeletes({ env: envWithCreds(), fetchImpl, store });
  assert.equal(flushed, 0);
  assert.equal(fetchImpl.calls.length, 0);
});
