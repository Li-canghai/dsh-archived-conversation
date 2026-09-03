// Regression tests for dsh-archived-conversation (host half).
//
// Loads the real plugin module with a mocked ctx against a temp sandbox and
// verifies the A+B+C+D performance-optimization contract:
//   1. cold start (no persistent cache): titles resolved through the
//      alpha.3/alpha.4 SessionPersistence.inspect contract
//   2. "restart" (fresh module, persistent cache present): titles served with
//      ZERO slow-path calls (inspect never invoked)
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
const pendingPath = join(sandbox, "archived-conversation-pending.json");
process.env.ARCHIVED_CONV_SESSIONS_BASE = sessionsBase;
process.env.ARCHIVED_CONV_TITLES_PATH = titlesPath;
process.env.ARCHIVED_CONV_PENDING_PATH = pendingPath;

const GUI_HOST = "127.0.0.1:3080";
const GUI_ORIGIN = `http://${GUI_HOST}`;
const JSON_HEADERS = {
  host: GUI_HOST,
  origin: GUI_ORIGIN,
  "content-type": "application/json",
};

const IDS = {
  A: "session-aaaa0000-0000-0000-0000-00000000000a", // big log, projcache hit
  B: "session-bbbb0000-0000-0000-0000-00000000000b", // big log, projcache miss -> slow path
  C: "session-cccc0000-0000-0000-0000-00000000000c", // dir missing entirely
  CHILD: "session-child000-0000-0000-0000-000000000001",
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
let inspectCalls = 0;
let registryListCalls = 0;
let headerCalls = 0;

const projTitles = { [IDS.A]: "项目A标题", [IDS.C]: "项目C标题" };
const projectionCache = {
  cachedSnapshot: (header) => {
    const t = projTitles[header?.id];
    return t ? { values: { title: t } } : undefined;
  },
};

let capturedHandler = null;
const effects = [];
// cross-phase state (stashed module-level, not globalThis)
let persistedRaw = null;
let ctx2 = null;
let m2 = null;

function makeCtx(opts = {}) {
  const detachSession = opts.detachSession || (async () => {});
  const readSessionHeader = opts.readSessionHeader || (async (id) => ({ id, createdAt: 1, cwd: "/proj" }));
  const archivedIds = opts.archivedIds || [IDS.A, IDS.B, IDS.C];
  const wsPath = opts.wsPath || "/proj";
  const sessionIds = opts.sessionIds || archivedIds;
  const extraGet = opts.get || {};
  const wsState = {
    archivedSessionIds: [...archivedIds],
  };
  const emitted = [];
  const registry = {
    archivedSessionIds: wsState.archivedSessionIds,
    list: () => {
      registryListCalls++;
      return [
        { id: "w1", record: { id: "w1", title: "proj", path: wsPath }, sessionIds: [...sessionIds] },
      ];
    },
    readSessionHeader: async (id) => {
      headerCalls++;
      return readSessionHeader(id);
    },
    requireState: () => wsState,
    setState: async (s) => {
      wsState.archivedSessionIds = s.archivedSessionIds;
    },
    enqueueOperation: async (fn) => fn(),
    get: () => ({ detachSession }),
  };
  return {
    get: (name) => {
      if (Object.hasOwn(extraGet, name)) return extraGet[name];
      if (name === "sessions") return new Map();
      if (name === "sessionProjectionCache") return projectionCache;
      return undefined;
    },
    workspaceRegistry: registry,
    sessionPersistence: {
      list: async () => [],
      inspect: async (id) => {
        inspectCalls++;
        if (id === IDS.B) {
          return { events: [{ seq: 5, type: "session/title", data: { title: "项目B标题" } }] };
        }
        return { events: [] };
      },
      readFrom: async () => {
        assert.fail("alpha.3/alpha.4 title lookup must not depend on readFrom offset semantics");
      },
    },
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    webServer: {
      port: 3080,
      register: (def) => { capturedHandler = def.handler; return {}; },
    },
    emit: (event, ...args) => { emitted.push([event, ...args]); },
    emitted,
    effect: (fn) => {
      effects.push(fn);
    },
    inject: (names, callback) => {
      if (!Array.isArray(names) || typeof callback !== "function") return;
      if (!names.includes("agents")) return;
      const agents = extraGet.agents;
      if (agents === undefined) return;
      callback({ agents });
    },
  };
}

// Fresh module instance per "restart": a unique query string forces Node to
// re-evaluate the module so the in-memory caches start empty.
const pluginUrl = new URL("../lib/index.js", import.meta.url);
async function freshModule() {
  return import(pluginUrl.href + "?v=" + Math.random());
}

async function call(method, url, headers = {}) {
  let status = 0;
  let body;
  const res = {
    writeHead(s) { status = s; },
    end: (b) => { body = JSON.parse(b); },
  };
  await capturedHandler({ method, url, headers }, res);
  return { status, body };
}

async function callList(mod) {
  const r = await call("GET", "/archived-conversation/api/list");
  return r.body;
}

async function callDelete(id) {
  const r = await call("DELETE", `/archived-conversation/api/${id}`, JSON_HEADERS);
  return r.body;
}

async function callUnarchive(id) {
  const r = await call("POST", `/archived-conversation/api/${id}/unarchive`, JSON_HEADERS);
  return r.body;
}

after(() => {
  for (const fn of effects) fn?.();
  rmSync(sandbox, { recursive: true, force: true });
});

// ============ Phase 1: cold start (no persistent cache) ============
test("冷启动:无持久化缓存时解析标题并写盘", async () => {
  registryListCalls = 0;
  const m1 = await freshModule();
  m1.apply(makeCtx());
  const cold = await callList(m1);
  assert.equal(cold.groups.length, 1);
  assert.equal(cold.groups[0].sessions.length, 3);
  const byId = Object.fromEntries(cold.groups[0].sessions.map((s) => [s.id, s]));
  assert.equal(byId[IDS.A].title, "项目A标题", "A 走 projcache 快路径");
  assert.equal(byId[IDS.B].title, "项目B标题", "B 走慢路径(inspect)");
  assert.equal(byId[IDS.C].title, "项目C标题", "C 无目录也由 projcache 提供");
  assert.equal(inspectCalls, 1, "inspect 只对 B 调用一次");
  assert.equal(registryListCalls, 1, "列表重建只枚举一次 workspace");

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
  inspectCalls = 0;
  headerCalls = 0;
  const m2b = await freshModule();
  const ctx2b = makeCtx();
  m2b.apply(ctx2b);
  const warm = await callList(m2b);
  ctx2 = ctx2b;
  m2 = m2b;
  const byId = Object.fromEntries(warm.groups[0].sessions.map((s) => [s.id, s]));
  assert.equal(byId[IDS.A].title, "项目A标题");
  assert.equal(byId[IDS.B].title, "项目B标题");
  assert.equal(inspectCalls, 0, "重启后不触发任何全量解压");
  assert.equal(headerCalls, 0, "持久化标题缓存命中时不读取 session header");
});

// ============ Phase 3: log fingerprint change ============
test("日志指纹变化:重读但走 projcache 快路径,零解压,持久化缓存刷新", async () => {
  inspectCalls = 0;
  // The session gained events: DSH's projection cache now has a fresher title.
  projTitles[IDS.A] = "项目A标题v2";
  const logA = join(sessionsBase, "--proj--", IDS.A, "session.jsonl.zstd");
  const st = statSync(logA);
  utimesSync(logA, new Date(), new Date(st.mtimeMs + 2000)); // change mtime only
  const changed = await callList(m2);
  const byId = Object.fromEntries(changed.groups[0].sessions.map((s) => [s.id, s]));
  assert.equal(byId[IDS.A].title, "项目A标题v2", "拾取到更新后的 projcache 标题");
  assert.equal(inspectCalls, 0, "指纹变化也不触发全量解压");
  await new Promise((r) => setTimeout(r, 500));
  const persisted2 = JSON.parse(readFileSync(titlesPath, "utf8"));
  assert.notEqual(persisted2[IDS.A].fp, persistedRaw[IDS.A].fp, "持久化缓存指纹已更新");
  assert.equal(persisted2[IDS.A].title, "项目A标题v2", "持久化缓存标题已更新");
});

test("并发列表请求共享同一次重建", async () => {
  headerCalls = 0;
  writeFileSync(titlesPath, "{}");
  const m = await freshModule();
  m.apply(makeCtx({
    readSessionHeader: async (id) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { id, createdAt: 1, cwd: "/proj" };
    },
  }));
  try {
    const [first, second] = await Promise.all([callList(m), callList(m)]);
    assert.deepEqual(first, second);
    assert.equal(headerCalls, 3, "三个会话各读取一次 header,不因并发请求翻倍");
  } finally {
    // Restore the shared handler used by the mutation smoke tests below.
    m2.apply(ctx2);
  }
});

test("归档主对话包含只读子代理树,子对话不能单独取消归档或删除", async () => {
  const m = await freshModule();
  try {
    m.apply(makeCtx({
    archivedIds: [IDS.A],
    get: {
      subagents: {
        async listDescendants(rootId) {
          assert.equal(rootId, IDS.A);
          return [{
            kind: "child",
            id: IDS.CHILD,
            parentId: IDS.A,
            depth: 1,
            mode: "continuable",
            label: "核实审批链路",
            activity: "inactive",
            hasChildren: false,
          }];
        },
      },
    },
    }));

  const listed = await callList(m);
  const root = listed.groups[0].sessions[0];
  assert.equal(root.id, IDS.A);
  assert.deepEqual(root.children, [{
    id: IDS.CHILD,
    parentId: IDS.A,
    depth: 1,
    title: "核实审批链路",
    mode: "continuable",
  }]);

  const unarchiveResult = await call("POST", `/archived-conversation/api/${IDS.CHILD}/unarchive`, JSON_HEADERS);
  assert.equal(unarchiveResult.status, 409);
  assert.match(unarchiveResult.body.error, /主对话/);
  const deleteResult = await call("DELETE", `/archived-conversation/api/${IDS.CHILD}`, JSON_HEADERS);
  assert.equal(deleteResult.status, 409);
    assert.match(deleteResult.body.error, /主对话/);
  } finally {
    m2.apply(ctx2);
  }
});

test("删除归档主对话时按子级优先统一删除完整子代理树", async () => {
  const rootId = "session-family0000-0000-0000-0000-000000000001";
  const childId = "session-family0000-0000-0000-0000-000000000002";
  makeSession(rootId, 64);
  makeSession(childId, 64);
  const detached = [];
  const m = await freshModule();
  try {
    m.apply(makeCtx({
      archivedIds: [rootId],
      sessionIds: [rootId, childId],
      detachSession: async (id) => { detached.push(id); },
      get: {
        subagents: {
          async listDescendants(id) {
            if (id !== rootId) return [];
            return [{ kind: "child", id: childId, parentId: rootId, depth: 1, mode: "one-shot", label: "子任务", activity: "inactive", hasChildren: false }];
          },
        },
      },
    }));
    const result = await callDelete(rootId);
    assert.equal(result.ok, true);
    assert.deepEqual(detached, [childId, rootId]);
    assert.equal(existsSync(join(sessionsBase, "--proj--", childId)), false);
    assert.equal(existsSync(join(sessionsBase, "--proj--", rootId)), false);
  } finally {
    m2.apply(ctx2);
  }
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
  assert.deepEqual(
    ctx2.emitted.filter(([event]) => event === "api-session/removed"),
    [["api-session/removed", IDS.B]],
    "冷会话删除只向 API 会话列表发布精确的 session id",
  );
  assert.equal(
    ctx2.emitted.some(([event]) => event === "session/disposed"),
    false,
    "不得用 { id } 伪造要求完整 Session 的宿主生命周期事件",
  );
});

test("GET /ping 无 Origin 仍为 200", async () => {
  const r = await call("GET", "/archived-conversation/api/ping");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.version, "string");
});

test("POST 无 Origin 返回 403", async () => {
  const r = await call("POST", `/archived-conversation/api/${IDS.A}/unarchive`, {
    host: GUI_HOST,
    "content-type": "application/json",
  });
  assert.equal(r.status, 403);
});

test("POST 恶意 Origin 返回 403", async () => {
  const r = await call("POST", `/archived-conversation/api/${IDS.A}/unarchive`, {
    host: GUI_HOST,
    origin: "http://evil.example",
    "content-type": "application/json",
  });
  assert.equal(r.status, 403);
});

test("POST 非 loopback Host 返回 403", async () => {
  const r = await call("POST", `/archived-conversation/api/${IDS.A}/unarchive`, {
    host: "attacker.com:3080",
    origin: "http://attacker.com:3080",
    "content-type": "application/json",
  });
  assert.equal(r.status, 403);
});

test("POST 非 JSON Content-Type 返回 415", async () => {
  const r = await call("POST", `/archived-conversation/api/${IDS.A}/unarchive`, {
    host: GUI_HOST,
    origin: GUI_ORIGIN,
    "content-type": "application/x-www-form-urlencoded",
  });
  assert.equal(r.status, 415);
});

test("取消归档不在归档集合中的会话返回 404", async () => {
  const r = await call("POST", `/archived-conversation/api/${IDS.C}/unarchive`, JSON_HEADERS);
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
});

test("detach 失败时不改归档状态、不删目录,并排队", async () => {
  const m = await freshModule();
  const ctx = makeCtx({
    detachSession: async () => {
      throw new Error("detach boom");
    },
  });
  m.apply(ctx);
  const dir = join(sessionsBase, "--proj--", IDS.A);
  assert.ok(existsSync(dir));
  const r = await call("DELETE", `/archived-conversation/api/${IDS.A}`, JSON_HEADERS);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.queued, true);
  assert.ok(ctx.workspaceRegistry.requireState().archivedSessionIds.includes(IDS.A));
  assert.ok(existsSync(dir), "detach 失败不得删除会话目录");
});

test("同源守卫: Origin 必须匹配 Host,且仅接受 loopback", async () => {
  const m = await freshModule();
  assert.equal(m.isSameOriginMutation({ headers: { host: GUI_HOST, origin: GUI_ORIGIN } }), true);
  assert.equal(m.isSameOriginMutation({ headers: { host: GUI_HOST } }), false);
  assert.equal(m.isSameOriginMutation({
    headers: { host: GUI_HOST, origin: "http://evil.example" },
  }), false);
  assert.equal(m.isLoopbackHostname("127.0.0.1"), true);
  assert.equal(m.isLoopbackHostname("192.168.1.1"), false);
  assert.equal(m.isJsonContentType({ headers: { "content-type": "application/json; charset=utf-8" } }), true);
  assert.equal(m.resolveGuiOrigin({ headers: { host: GUI_HOST } }, 3080), GUI_ORIGIN);
  assert.equal(m.resolveGuiOrigin({ headers: { host: "192.168.1.8:3080" } }, 3080), null);
});

function makeLedgerSpy(targetId) {
  const deleted = [];
  const points = [
    { id: "rp_keep_other", kind: "turn", sessionId: "session-other", workspace: "/proj" },
    { id: "rp_turn_target", kind: "turn", sessionId: targetId, workspace: "/proj" },
    { id: "rp_rescue_target", kind: "rescue", sessionId: targetId, workspace: "/proj" },
    { id: "rp_user_nosession", kind: "user", workspace: "/proj" },
  ];
  return {
    deleted,
    listCalls: [],
    async list(options) {
      this.listCalls.push(options);
      return points.filter((p) => !deleted.includes(p.id));
    },
    async delete(options) {
      deleted.push(options.restorePointId);
      return { restorePointId: options.restorePointId, deletedBlobs: 1, retainedBlobs: 0 };
    },
  };
}

test("删除归档对话时清掉该会话的 rewind 检查点与 review 快照", async () => {
  const sid = "session-purge0000-0000-0000-0000-000000000001";
  makeSession(sid, 64);
  const ledger = makeLedgerSpy(sid);
  const forgotten = [];
  const m = await freshModule();
  m.apply(makeCtx({
    archivedIds: [sid],
    get: {
      changeLedger: ledger,
      turnReview: { forget: (id) => forgotten.push(id) },
    },
  }));
  const body = await callDelete(sid);
  assert.equal(body.ok, true);
  assert.equal(ledger.listCalls.length, 1);
  assert.equal(ledger.listCalls[0].cwd, "/proj");
  assert.equal(ledger.listCalls[0].includeRescue, true);
  assert.equal(ledger.listCalls[0].includeTurnCheckpoints, true);
  assert.deepEqual(ledger.deleted.sort(), ["rp_rescue_target", "rp_turn_target"]);
  assert.equal(ledger.deleted.includes("rp_keep_other"), false);
  assert.equal(ledger.deleted.includes("rp_user_nosession"), false);
  assert.deepEqual(forgotten, [sid]);
});

test("优先走 changeLedger.deleteBySession", async () => {
  const sid = "session-purge0000-0000-0000-0000-000000000006";
  makeSession(sid, 64);
  const calls = [];
  const forgotten = [];
  const m = await freshModule();
  m.apply(makeCtx({
    archivedIds: [sid],
    get: {
      changeLedger: {
        async deleteBySession(options) {
          calls.push(options);
          return { deletedRestorePoints: 2, deletedOperations: 0, deletedSkips: 0 };
        },
        async list() { throw new Error("list should not run"); },
        async delete() { throw new Error("delete should not run"); },
      },
      turnReview: { forget: (id) => forgotten.push(id) },
    },
  }));
  const body = await callDelete(sid);
  assert.equal(body.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, sid);
  assert.equal(calls[0].cwd, "/proj");
  assert.deepEqual(forgotten, [sid]);
});

test("删除 rewind 检查点时 confirmation 必须是 DELETE <id>", async () => {
  const sid = "session-purge0000-0000-0000-0000-000000000002";
  makeSession(sid, 64);
  const confirmations = [];
  const m = await freshModule();
  m.apply(makeCtx({
    archivedIds: [sid],
    get: {
      changeLedger: {
        async list() {
          return [{ id: "rp_one", kind: "turn", sessionId: sid, workspace: "/proj" }];
        },
        async delete(options) {
          confirmations.push(options);
          return { restorePointId: options.restorePointId, deletedBlobs: 0, retainedBlobs: 0 };
        },
      },
    },
  }));
  const body = await callDelete(sid);
  assert.equal(body.ok, true);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].restorePointId, "rp_one");
  assert.equal(confirmations[0].confirmation, "DELETE rp_one");
  assert.equal(confirmations[0].cwd, "/proj");
});

test("取消归档不清 rewind 检查点也不 forget review 快照", async () => {
  const sid = "session-purge0000-0000-0000-0000-000000000003";
  makeSession(sid, 64);
  let listCalls = 0;
  let forgetCalls = 0;
  const m = await freshModule();
  m.apply(makeCtx({
    archivedIds: [sid],
    get: {
      changeLedger: {
        async list() { listCalls++; return []; },
        async delete() { throw new Error("delete should not run"); },
      },
      turnReview: { forget: () => { forgetCalls++; } },
    },
  }));
  const body = await callUnarchive(sid);
  assert.equal(body.ok, true);
  assert.equal(listCalls, 0);
  assert.equal(forgetCalls, 0);
  assert.ok(existsSync(join(sessionsBase, "--proj--", sid)), "取消归档不得删除会话目录");
});

test("sidecar 清理失败不阻断会话删除", async () => {
  const sid = "session-purge0000-0000-0000-0000-000000000004";
  makeSession(sid, 64);
  const dir = join(sessionsBase, "--proj--", sid);
  const m = await freshModule();
  m.apply(makeCtx({
    archivedIds: [sid],
    get: {
      changeLedger: {
        async deleteBySession() { throw new Error("ledger boom"); },
        async list() { throw new Error("ledger boom"); },
        async delete() { throw new Error("delete boom"); },
      },
      turnReview: { forget: () => { throw new Error("forget boom"); } },
    },
  }));
  const body = await callDelete(sid);
  assert.equal(body.ok, true);
  assert.ok(!existsSync(dir), "会话目录仍应删除");
});

test("无 changeLedger / turnReview 时删除仍成功", async () => {
  const sid = "session-purge0000-0000-0000-0000-000000000005";
  makeSession(sid, 64);
  const m = await freshModule();
  m.apply(makeCtx({ archivedIds: [sid] }));
  const body = await callDelete(sid);
  assert.equal(body.ok, true);
  assert.ok(!existsSync(join(sessionsBase, "--proj--", sid)));
});

test("attached 会话在只有 scope.dispose 时仍排队", async () => {
  const sid = "session-attached000-0000-0000-0000-000000000001";
  makeSession(sid, 64);
  const dir = join(sessionsBase, "--proj--", sid);
  const sessions = new Map([[sid, { id: sid }]]);
  const agent = {
    id: sid,
    status: "idle",
    scope: { dispose: async () => {} },
  };
  process.env.ARCHIVED_CONV_VERIFY_STEP_MS = "0";
  try {
    const m = await freshModule();
    m.apply(makeCtx({
      archivedIds: [sid],
      get: {
        sessions: { get: (id) => sessions.get(id) },
        agents: { get: (id) => (id === sid ? agent : undefined) },
      },
    }));
    const r = await call("DELETE", `/archived-conversation/api/${sid}`, JSON_HEADERS);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.queued, true);
    assert.match(r.body.error, /仍在使用中/);
    assert.ok(existsSync(dir), "未释放时不得删除会话目录");
  } finally {
    delete process.env.ARCHIVED_CONV_VERIFY_STEP_MS;
  }
});

test("捕获 AgentHandle.dispose 后可直接删除仍挂起的空闲会话", async () => {
  const sid = "session-attached000-0000-0000-0000-000000000002";
  makeSession(sid, 64);
  const dir = join(sessionsBase, "--proj--", sid);
  const sessions = new Map([[sid, { id: sid }]]);
  const agent = {
    id: sid,
    status: "idle",
    scope: { dispose: async () => {} },
  };
  const handle = {
    agent,
    dispose: async () => {
      sessions.delete(sid);
    },
  };
  const agents = {
    get: (id) => (id === sid ? agent : undefined),
    create: async () => handle,
    resume: async () => handle,
  };
  const m = await freshModule();
  m.apply(makeCtx({
    archivedIds: [sid],
    get: {
      sessions: { get: (id) => sessions.get(id) },
      agents,
    },
  }));
  await agents.resume({ resumeSessionId: sid });
  const body = await callDelete(sid);
  assert.equal(body.ok, true);
  assert.equal(sessions.has(sid), false);
  assert.ok(!existsSync(dir), "释放后应删除会话目录");
});
