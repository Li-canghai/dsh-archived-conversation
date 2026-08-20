// Regression tests for dsh-archived-conversation (host half).
//
// Loads the real plugin module with a mocked ctx against a temp sandbox and
// verifies the A+B+C+D performance-optimization contract:
//   1. cold start (no persistent cache): titles resolved, cache file written
//   2. "restart" (fresh module, persistent cache present): titles served with
//      ZERO slow-path calls (coldSnapshot/readFrom never invoked)
//   3. log fingerprint change: re-read but served via the projcache fast path
//      (still zero decompression), persistent cache fp/title refreshed
//   4. missing-dir session slot: served from the persistent cache ("missing" fp)
//   5. unarchive + delete still behave (quick smoke)
//
// Run: npm test (node --test tests/)
// The sandbox lives under the OS temp dir; the real ~/.dsh is never touched
// (paths are injected through ARCHIVED_CONV_* env vars).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "arch-conv-test-"));
const sessionsBase = join(sandbox, "sessions");
const titlesPath = join(sandbox, "archived-conversation-titles.json");
process.env.ARCHIVED_CONV_SESSIONS_BASE = sessionsBase;
process.env.ARCHIVED_CONV_TITLES_PATH = titlesPath;

const IDS = {
  A: "session-aaaa0000-0000-0000-0000-00000000000a", // big log, projcache hit
  B: "session-bbbb0000-0000-0000-0000-00000000000b", // big log, projcache miss -> slow path
  C: "session-cccc0000-0000-0000-0000-00000000000c", // dir missing entirely
};

function makeSession(id, bytes) {
  const dir = join(sessionsBase, "--proj--", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl.zstd"), Buffer.alloc(bytes, 1));
}
makeSession(IDS.A, 1024 * 1024);
makeSession(IDS.B, 2 * 1024 * 1024);
// C has no dir on disk.

// ---- counters for slow paths ----
let coldSnapshotCalls = 0;
let readFromCalls = 0;

const projTitles = { [IDS.A]: "项目A标题", [IDS.C]: "项目C标题" };
const projectionCache = {
  cachedSnapshot: (header) => {
    const t = projTitles[header?.id];
    return t ? { values: { title: t } } : undefined;
  },
  coldSnapshot: async () => {
    coldSnapshotCalls++;
    return undefined; // no title via projection
  },
};

let capturedHandler = null;
const effects = [];
// cross-phase state (stashed module-level, not globalThis)
let persistedRaw = null;
let ctx2 = null;
let m2 = null;

function makeCtx() {
  const wsState = {
    archivedSessionIds: [IDS.A, IDS.B, IDS.C],
  };
  const registry = {
    archivedSessionIds: wsState.archivedSessionIds,
    list: () => [
      { id: "w1", record: { id: "w1", title: "proj", path: "/proj" }, sessionIds: [IDS.A, IDS.B, IDS.C] },
    ],
    readSessionHeader: async (id) => ({ id, createdAt: 1, cwd: "/proj" }),
    requireState: () => wsState,
    setState: async (s) => {
      wsState.archivedSessionIds = s.archivedSessionIds;
    },
    enqueueOperation: async (fn) => fn(),
    get: () => ({ detachSession: async () => {} }),
  };
  return {
    get: (name) =>
      name === "sessions"
        ? new Map()
        : name === "sessionProjectionCache"
          ? projectionCache
          : undefined,
    workspaceRegistry: registry,
    sessionPersistence: {
      list: async () => [],
      readFrom: async (id) => {
        readFromCalls++;
        if (id === IDS.B) {
          return { events: [{ seq: 5, type: "session/title", data: { title: "项目B标题" } }] };
        }
        return { events: [] };
      },
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    webServer: { register: (def) => { capturedHandler = def.handler; return {}; } },
    emit: () => {},
    effect: (fn) => {
      effects.push(fn);
    },
  };
}

// Fresh module instance per "restart": a unique query string forces Node to
// re-evaluate the module so the in-memory caches start empty.
const pluginUrl = new URL("../lib/index.js", import.meta.url);
async function freshModule() {
  return import(pluginUrl.href + "?v=" + Math.random());
}

async function callList(mod) {
  let body;
  const res = { writeHead() {}, end: (b) => { body = JSON.parse(b); } };
  await capturedHandler({ method: "GET", url: "/archived-conversation/api/list" }, res);
  return body;
}

async function callDelete(id) {
  let body;
  const res = { writeHead() {}, end: (b) => { body = JSON.parse(b); } };
  await capturedHandler({ method: "DELETE", url: `/archived-conversation/api/${id}` }, res);
  return body;
}

async function callUnarchive(id) {
  let body;
  const res = { writeHead() {}, end: (b) => { body = JSON.parse(b); } };
  await capturedHandler({ method: "POST", url: `/archived-conversation/api/${id}/unarchive` }, res);
  return body;
}

after(() => {
  for (const fn of effects) fn?.();
  rmSync(sandbox, { recursive: true, force: true });
});

// ============ Phase 1: cold start (no persistent cache) ============
test("冷启动:无持久化缓存时解析标题并写盘", async () => {
  const m1 = await freshModule();
  m1.apply(makeCtx());
  const cold = await callList(m1);
  assert.equal(cold.groups.length, 1);
  assert.equal(cold.groups[0].sessions.length, 3);
  const byId = Object.fromEntries(cold.groups[0].sessions.map((s) => [s.id, s]));
  assert.equal(byId[IDS.A].title, "项目A标题", "A 走 projcache 快路径");
  assert.equal(byId[IDS.B].title, "项目B标题", "B 走慢路径(readFrom)");
  assert.equal(byId[IDS.C].title, "项目C标题", "C 无目录也由 projcache 提供");
  assert.equal(readFromCalls, 1, "readFrom 只对 B 调用一次");
  assert.equal(coldSnapshotCalls, 1, "coldSnapshot 只对 B 调用一次");

  // wait for the debounced title-cache write
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(existsSync(titlesPath), "持久化标题缓存已写盘");
  const persistedRaw0 = JSON.parse(readFileSync(titlesPath, "utf8"));
  for (const id of [IDS.A, IDS.B, IDS.C]) {
    assert.ok(persistedRaw0[id] && typeof persistedRaw0[id].fp === "string", `${id} 已入持久化缓存`);
  }
  assert.equal(persistedRaw0[IDS.C].fp, "missing", "无目录会话指纹为 missing");
  // stash for later phases
  persistedRaw = persistedRaw0;
});

// ============ Phase 2: simulated restart (fresh module + persistent cache) ============
test("模拟重启:持久化缓存在场,零慢路径调用", async () => {
  coldSnapshotCalls = 0;
  readFromCalls = 0;
  const m2b = await freshModule();
  const ctx2b = makeCtx();
  m2b.apply(ctx2b);
  const warm = await callList(m2b);
  const byId = Object.fromEntries(warm.groups[0].sessions.map((s) => [s.id, s]));
  assert.equal(byId[IDS.A].title, "项目A标题");
  assert.equal(byId[IDS.B].title, "项目B标题");
  assert.equal(readFromCalls, 0, "重启后不触发任何全量解压");
  assert.equal(coldSnapshotCalls, 0, "重启后不触发 coldSnapshot");
  ctx2 = ctx2b;
  m2 = m2b;
});

// ============ Phase 3: log fingerprint change ============
test("日志指纹变化:重读但走 projcache 快路径,零解压,持久化缓存刷新", async () => {
  coldSnapshotCalls = 0;
  readFromCalls = 0;
  // The session gained events: DSH's projection cache now has a fresher title.
  projTitles[IDS.A] = "项目A标题v2";
  const logA = join(sessionsBase, "--proj--", IDS.A, "session.jsonl.zstd");
  const st = statSync(logA);
  utimesSync(logA, new Date(), new Date(st.mtimeMs + 2000)); // change mtime only
  const changed = await callList(m2);
  const byId = Object.fromEntries(changed.groups[0].sessions.map((s) => [s.id, s]));
  assert.equal(byId[IDS.A].title, "项目A标题v2", "拾取到更新后的 projcache 标题");
  assert.equal(readFromCalls, 0, "指纹变化也不触发全量解压");
  assert.equal(coldSnapshotCalls, 0, "指纹变化也不触发 coldSnapshot");
  await new Promise((r) => setTimeout(r, 500));
  const persisted2 = JSON.parse(readFileSync(titlesPath, "utf8"));
  assert.notEqual(persisted2[IDS.A].fp, persistedRaw[IDS.A].fp, "持久化缓存指纹已更新");
  assert.equal(persisted2[IDS.A].title, "项目A标题v2", "持久化缓存标题已更新");
});

// ============ Phase 4: unarchive smoke ============
test("取消归档冒烟", async () => {
  const body = await callUnarchive(IDS.C);
  assert.equal(body.ok, true);
  assert.equal(ctx2.workspaceRegistry.requireState().archivedSessionIds.length, 2);
});

// ============ Phase 5: delete (cold session, dir exists) ============
test("删除冒烟", async () => {
  const body = await callDelete(IDS.B);
  assert.equal(body.ok, true);
  assert.ok(!existsSync(join(sessionsBase, "--proj--", IDS.B)), "会话目录已删除");
  assert.ok(!ctx2.workspaceRegistry.requireState().archivedSessionIds.includes(IDS.B), "已从归档集合移除");
});
