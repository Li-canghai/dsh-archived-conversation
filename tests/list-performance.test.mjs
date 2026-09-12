import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";

async function harness(t, { count = 120, projects = 12, coldTitles = false, children = false, failedTitle = false } = {}) {
  const base = resolve("virtual-archived-performance");
  process.env.ARCHIVED_CONV_SESSIONS_BASE = base;
  process.env.ARCHIVED_CONV_TITLES_PATH = join(base, "titles.json");
  process.env.ARCHIVED_CONV_PENDING_PATH = join(base, "pending.json");
  process.env.DSH_ARCHIVED_CONVERSATION_OV_LINK = "0";
  const ids = Array.from({ length: count }, (_, i) => `session-perf-${i}`);
  const projectNames = Array.from({ length: projects }, (_, i) => `project-${i}`);
  const locations = new Map(ids.map((id) => [id, projectNames.at(-1)]));
  if (children) for (const id of ids) locations.set(`${id}-child`, projectNames.at(-1));
  const counts = { readdir: 0, stat: 0, headers: 0, inspect: 0, metadataPeak: 0, inspectPeak: 0, headerPeak: 0, familyPeak: 0 };
  let metadataActive = 0;
  let inspectActive = 0;
  let headerActive = 0;
  let familyActive = 0;
  const tick = () => new Promise((done) => setImmediate(done));
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const entry = (name) => ({ name, isDirectory: () => true });
  t.mock.method(fsp, "readdir", async (path, options) => {
    counts.readdir++;
    metadataActive++;
    counts.metadataPeak = Math.max(counts.metadataPeak, metadataActive);
    await tick();
    metadataActive--;
    let names;
    if (path === base) names = projectNames;
    else {
      const project = projectNames.find((name) => join(base, name) === path);
      if (!project) throw missing();
      names = [...locations].filter(([, value]) => value === project).map(([id]) => id);
    }
    return options?.withFileTypes ? names.map(entry) : names;
  });
  t.mock.method(fsp, "stat", async (path) => {
    counts.stat++;
    metadataActive++;
    counts.metadataPeak = Math.max(counts.metadataPeak, metadataActive);
    await tick();
    metadataActive--;
    for (const [id, project] of locations) {
      const dir = join(base, project, id);
      if (path === dir) return { isDirectory: () => true };
      if (path === join(dir, "session.jsonl.zstd")) return { mtimeMs: 100, size: 64 };
    }
    throw missing();
  });
  const readFileSync = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (path, ...args) => {
    if (path === process.env.ARCHIVED_CONV_TITLES_PATH) return "{}";
    if (path === process.env.ARCHIVED_CONV_PENDING_PATH) return "[]";
    return readFileSync(path, ...args);
  });
  t.mock.method(fs, "writeFileSync", () => {});
  t.mock.method(fs, "renameSync", () => {});
  syncBuiltinESMExports();
  const effects = [];
  t.after(() => {
    for (const dispose of effects) dispose();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  let handler;
  const ctx = {
    workspaceRegistry: {
      archivedSessionIds: ids,
      list: () => [{ record: { title: "Project", path: "/project" }, sessionIds: ids }],
      readSessionHeader: async (id) => {
        counts.headers++;
        counts.headerPeak = Math.max(counts.headerPeak, ++headerActive);
        await tick();
        headerActive--;
        if (failedTitle && id === ids[0]) throw missing();
        return { id };
      },
    },
    get: (name) => {
      if (name === "subagents" && children) return {
        listDescendants: async (id) => {
          counts.familyPeak = Math.max(counts.familyPeak, ++familyActive);
          await tick();
          familyActive--;
          return [{ kind: "child", id: `${id}-child`, parentId: id, depth: 1, mode: "once" }];
        },
      };
      if (name === "sessionProjectionCache") return {
        cachedSnapshot: (header) => coldTitles ? undefined : { values: { title: header.id } },
      };
      if (name === "sessionController") return {
        inspect: async (id) => {
          counts.inspect++;
          inspectActive++;
          counts.inspectPeak = Math.max(counts.inspectPeak, inspectActive);
          await tick();
          inspectActive--;
          if (failedTitle && id === ids[0]) throw missing();
          return { events: [{ type: "session/title", data: { title: id } }] };
        },
      };
    },
    effect: (dispose) => effects.push(dispose),
    inject: (names, callback) => {
      if (Array.isArray(names) && names.includes("connection")) {
        callback({
          connection: {
            registerFetchRoute: (owner, route) => {
              if (route.path === "/api/archived-conversation/list") handler = route.fetch;
              owner.effect(() => () => {});
            },
          },
        });
      }
    },
  };
  const mod = await import(`../lib/index.js?performance=${Math.random()}`);
  mod.apply(ctx);
  const list = async () => {
    const response = await handler(new Request("http://localhost/api/archived-conversation/list", {
      headers: { host: "127.0.0.1:3080" },
    }));
    assert.equal(response.status, 200);
    return await response.json();
  };
  return { list, ids, locations, counts };
}

test("cold directory discovery scales with projects plus sessions; warm refresh only stats logs", async (t) => {
  const h = await harness(t);
  const first = await h.list();
  assert.equal(first.groups[0].sessions.length, 120);
  t.diagnostic(`cold: readdir=${h.counts.readdir}, stat=${h.counts.stat}`);
  assert.ok(h.counts.readdir <= 13, "scan each project at most once, not once per session");
  assert.equal(h.counts.stat, 120, "one log stat per session, no candidate-directory probes");
  const before = { ...h.counts };
  assert.deepEqual(await h.list(), first);
  assert.equal(h.counts.readdir, before.readdir, "known directories need no rescanning");
  assert.equal(h.counts.stat - before.stat, 120);
  assert.equal(h.counts.headers, before.headers);
  assert.equal(h.counts.inspect, 0);
});

test("cold refresh bounds filesystem work and full-log inspections", async (t) => {
  const h = await harness(t, { count: 48, coldTitles: true });
  const result = await h.list();
  assert.deepEqual(result.groups[0].sessions.map((s) => s.title), h.ids);
  t.diagnostic(`peaks: metadata=${h.counts.metadataPeak}, inspect=${h.counts.inspectPeak}`);
  assert.ok(h.counts.metadataPeak <= 8, "filesystem work must stay bounded");
  assert.ok(h.counts.inspectPeak <= 2, "avoid decompressing every cold log at once");
  assert.ok(h.counts.inspectPeak > 1, "retain parallel progress");
  assert.equal(h.counts.inspect, 48);
});

test("a missing session directory is discovered when it appears on a later refresh", async (t) => {
  const h = await harness(t, { count: 1 });
  h.locations.clear();
  assert.equal((await h.list()).groups[0].sessions[0].updatedAt, null);
  h.locations.set(h.ids[0], "project-0");
  assert.equal((await h.list()).groups[0].sessions[0].updatedAt, 100);
});

test("a cached session directory can move between projects", async (t) => {
  const h = await harness(t, { count: 1 });
  const first = await h.list();
  h.locations.set(h.ids[0], "project-0");
  assert.deepEqual(await h.list(), first);
});

test("child titles share the concurrency budget and retain family order", async (t) => {
  const h = await harness(t, { count: 24, coldTitles: true, children: true });
  const result = await h.list();
  assert.deepEqual(result.groups[0].sessions.map((s) => s.children[0].title), h.ids.map((id) => `${id}-child`));
  assert.equal(h.counts.inspect, 48);
  assert.ok(h.counts.inspectPeak <= 2);
  assert.ok(h.counts.headerPeak <= 8);
  assert.ok(h.counts.familyPeak <= 8);
});

test("a failed header and log read does not prevent the remaining titles from loading", async (t) => {
  const h = await harness(t, { count: 16, coldTitles: true, failedTitle: true });
  const result = await h.list();
  assert.deepEqual(result.groups[0].sessions.map((s) => s.title), ["project", ...h.ids.slice(1)]);
  assert.equal(h.counts.headers, 16, "failed header is not read twice");
  assert.equal(h.counts.inspect, 16);
});