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
  A: "session-aaaa0000-0000-0000-0000-00000000000a",
  B: "session-bbbb0000-0000-0000-0000-00000000000b",
  C: "session-cccc0000-0000-0000-0000-00000000000c",
  CHILD: "session-child000-0000-0000-0000-000000000001",
};

function makeSession(id, bytes) {
  const dir = join(sessionsBase, "--proj--", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl.zstd"), Buffer.alloc(bytes, 1));
}
makeSession(IDS.A, 1024 * 1024);
makeSession(IDS.B, 2 * 1024 * 1024);

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

const apiRoutes = new Map();
const effects = [];
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
  const sessionController = opts.sessionController === null ? undefined
    : opts.sessionController || {
      inspect: async (id) => {
        inspectCalls++;
        if (id === IDS.B) {
          return { meta: { id }, inheritedEventCount: 0, events: [{ seq: 5, type: "session/title", data: { title: "项目B标题" } }] };
        }
        return { meta: { id }, inheritedEventCount: 0, events: [] };
      },
    };
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
      if (name === "sessionController") return sessionController;
      return undefined;
    },
    workspaceRegistry: registry,
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    emit: (event, ...args) => { emitted.push([event, ...args]); },
    emitted,
    effect: (fn) => {
      effects.push(fn);
    },
    inject: (names, callback) => {
      if (!Array.isArray(names) || typeof callback !== "function") return;
      if (names.includes("connection")) {
        callback({
          connection: {
            registerFetchRoute: (owner, route) => {
              apiRoutes.set(route.path, route);
              owner.effect(() => () => apiRoutes.delete(route.path));
            },
          },
        });
        return;
      }
      if (!names.includes("agents")) return;
      const agents = extraGet.agents;
      if (agents === undefined) return;
      callback({ agents });
    },
  };
}

const pluginUrl = new URL("../lib/index.js", import.meta.url);
async function freshModule() {
  return import(pluginUrl.href + "?v=" + Math.random());
}

async function call(method, url, headers = {}, body) {
  const route = apiRoutes.get(new URL(url, "http://localhost").pathname);
  assert.ok(route, `route not registered: ${url}`);
  const request = new Request(`http://localhost${url}`, {
    method,
    headers: { host: GUI_HOST, ...headers },
    ...(body === undefined ? {} : { body }),
  });
  const response = await route.fetch(request);
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : JSON.parse(text) };
}

async function callList(mod) {
  const r = await call("GET", "/api/archived-conversation/list");
  return r.body;
}

async function callDelete(id) {
  const r = await call("POST", "/api/archived-conversation/delete", JSON_HEADERS, JSON.stringify({ id }));
  return r.body;
}

async function callUnarchive(id) {
  const r = await call("POST", "/api/archived-conversation/unarchive", JSON_HEADERS, JSON.stringify({ id }));
  return r.body;
}

after(() => {
  for (const fn of effects) fn?.();
  rmSync(sandbox, { recursive: true, force: true });
});

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

  await new Promise((r) => setTimeout(r, 500));
  assert.ok(existsSync(titlesPath), "持久化标题缓存已写盘");
  const persistedRaw0 = JSON.parse(readFileSync(titlesPath, "utf8"));
  for (const id of [IDS.A, IDS.B, IDS.C]) {
    assert.ok(persistedRaw0[id] && typeof persistedRaw0[id].fp === "string", `${id} 已入持久化缓存`);
  }
  assert.equal(persistedRaw0[IDS.C].fp, "missing", "无目录会话指纹为 missing");
  persistedRaw = persistedRaw0;
});

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

test("日志指纹变化:重读但走 projcache 快路径,零解压,持久化缓存刷新", async () => {
  inspectCalls = 0;
  projTitles[IDS.A] = "项目A标题v2";
  const logA = join(sessionsBase, "--proj--", IDS.A, "session.jsonl.zstd");
  const st = statSync(logA);
  utimesSync(logA, new Date(), new Date(st.mtimeMs + 2000));
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
    m2.apply(ctx2);
  }
});

test("sessionController 缺失时降级为项目名回退,不抛错", async () => {
  const sid = "session-noinspect0-0000-0000-0000-000000000001";
  makeSession(sid, 64);
  const m = await freshModule();
  try {
    m.apply(makeCtx({
      archivedIds: [sid],
      sessionController: null,
    }));
    const listed = await callList(m);
    assert.equal(
      listed.groups[0].sessions[0].title,
      "proj",
      "无 inspect 通道时回退到工作区路径 basename",
    );
  } finally {
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

  const unarchiveResult = await call("POST", "/api/archived-conversation/unarchive", JSON_HEADERS, JSON.stringify({ id: IDS.CHILD }));
  assert.equal(unarchiveResult.status, 409);
  assert.match(unarchiveResult.body.error, /主对话/);
  const deleteResult = await call("POST", "/api/archived-conversation/delete", JSON_HEADERS, JSON.stringify({ id: IDS.CHILD }));
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

test("取消归档冒烟", async () => {
  const body = await callUnarchive(IDS.C);
  assert.equal(body.ok, true);
  assert.equal(ctx2.workspaceRegistry.requireState().archivedSessionIds.length, 2);
});

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
  const r = await call("GET", "/api/archived-conversation/ping");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.version, "string");
});

test("POST 无 Origin 仍通过栅栏(Desktop 管道语义),未归档 id 返回 404", async () => {
  const r = await call("POST", "/api/archived-conversation/unarchive", {
    host: GUI_HOST,
    "content-type": "application/json",
  }, JSON.stringify({ id: IDS.C }));
  assert.equal(r.status, 404);
  assert.equal(r.body.ok, false);
});

test("POST 恶意 Origin 返回 403", async () => {
  const r = await call("POST", "/api/archived-conversation/unarchive", {
    host: GUI_HOST,
    origin: "http://evil.example",
    "content-type": "application/json",
  }, JSON.stringify({ id: IDS.A }));
  assert.equal(r.status, 403);
});

test("POST 非 JSON Content-Type 返回 415", async () => {
  const r = await call("POST", "/api/archived-conversation/unarchive", {
    host: GUI_HOST,
    origin: GUI_ORIGIN,
    "content-type": "application/x-www-form-urlencoded",
  }, "id=x");
  assert.equal(r.status, 415);
});

test("POST 非法 id 返回 400", async () => {
  const r = await call("POST", "/api/archived-conversation/delete", JSON_HEADERS, JSON.stringify({ id: "../evil" }));
  assert.equal(r.status, 400);
});

test("取消归档不在归档集合中的会话返回 404", async () => {
  const r = await call("POST", "/api/archived-conversation/unarchive", JSON_HEADERS, JSON.stringify({ id: IDS.C }));
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
  const r = await call("POST", "/api/archived-conversation/delete", JSON_HEADERS, JSON.stringify({ id: IDS.A }));
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.queued, true);
  assert.ok(ctx.workspaceRegistry.requireState().archivedSessionIds.includes(IDS.A));
  assert.ok(existsSync(dir), "detach 失败不得删除会话目录");
});

test("同源守卫: Origin 必须匹配 Host;跨源判定由 isCrossOriginMutation 承担", async () => {
  const m = await freshModule();
  assert.equal(m.isSameOriginMutation({ headers: { host: GUI_HOST, origin: GUI_ORIGIN } }), true);
  assert.equal(m.isSameOriginMutation({ headers: { host: GUI_HOST } }), false);
  assert.equal(m.isSameOriginMutation({
    headers: { host: GUI_HOST, origin: "http://evil.example" },
  }), false);
  assert.equal(m.isJsonContentType({ headers: { "content-type": "application/json; charset=utf-8" } }), true);
  assert.equal(m.isCrossOriginMutation({ headers: { host: GUI_HOST } }), false);
  assert.equal(m.isCrossOriginMutation({ headers: { host: GUI_HOST, origin: GUI_ORIGIN } }), false);
  assert.equal(m.isCrossOriginMutation({ headers: { host: GUI_HOST, origin: "http://evil.example" } }), true);
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
    const r = await call("POST", "/api/archived-conversation/delete", JSON_HEADERS, JSON.stringify({ id: sid }));
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

test("rm 失败后:会话已出归档但目录残留时,processPendingDeletes 持续清扫直至目录消失", async () => {
  const sid = "session-residual000-0000-0000-0000-000000000001";
  const dir = join(sessionsBase, "--proj--", sid);
  makeSession(sid, 16);
  writeFileSync(pendingPath, JSON.stringify([sid], null, 2));
  const m = await freshModule();
  m.apply(makeCtx({ archivedIds: [IDS.A, IDS.B] }));
  assert.ok(existsSync(dir), "前置:残留目录存在");
  await m.processPendingDeletes(makeCtx({ archivedIds: [IDS.A, IDS.B] }), true);
  assert.ok(!existsSync(dir), "残留目录应被清扫");
  const queued = JSON.parse(readFileSync(pendingPath, "utf8"));
  assert.ok(!queued.includes(sid), "队列条目应在目录清除后移除");
});

test("取消归档同时撤销排队中的删除,活会话目录不得被清扫", async () => {
  const sid = "session-unarchcan000-0000-0000-0000-000000000001";
  const dir = join(sessionsBase, "--proj--", sid);
  makeSession(sid, 16);
  writeFileSync(pendingPath, JSON.stringify([sid], null, 2));
  const m = await freshModule();
  m.apply(makeCtx({ archivedIds: [sid] }));
  const body = await callUnarchive(sid);
  assert.equal(body.ok, true);
  assert.deepEqual(JSON.parse(readFileSync(pendingPath, "utf8")), [], "排队删除应被撤销");
  assert.ok(existsSync(dir), "取消归档后活会话目录必须保留");
});

test("清扫护栏:会话仍在工作区(排队后取消归档)时不得 rm 其目录", async () => {
  const sid = "session-sweepfence00-0000-0000-0000-000000000001";
  const dir = join(sessionsBase, "--proj--", sid);
  makeSession(sid, 16);
  writeFileSync(pendingPath, JSON.stringify([sid], null, 2));
  const m = await freshModule();
  m.apply(makeCtx({ archivedIds: [], sessionIds: [sid] }));
  await m.processPendingDeletes(makeCtx({ archivedIds: [], sessionIds: [sid] }), true);
  assert.ok(existsSync(dir), "仍持有工作区槽位的会话目录不得被清扫");
  assert.deepEqual(JSON.parse(readFileSync(pendingPath, "utf8")), [], "被取消的队列条目应移除");
});

test("清扫护栏:会话重新激活(active)时不得 rm 其目录", async () => {
  const sid = "session-sweepfence00-0000-0000-0000-000000000002";
  const dir = join(sessionsBase, "--proj--", sid);
  makeSession(sid, 16);
  writeFileSync(pendingPath, JSON.stringify([sid], null, 2));
  const m = await freshModule();
  m.apply(makeCtx({
    archivedIds: [],
    sessionIds: [],
    get: { sessions: { get: (id) => (id === sid ? { id: sid } : undefined) } },
  }));
  await m.processPendingDeletes(makeCtx({
    archivedIds: [],
    sessionIds: [],
    get: { sessions: { get: (id) => (id === sid ? { id: sid } : undefined) } },
  }), true);
  assert.ok(existsSync(dir), "active 会话目录不得被清扫");
  assert.deepEqual(JSON.parse(readFileSync(pendingPath, "utf8")), [], "被取消的队列条目应移除");
});

test("残留清扫完成后补齐删除收尾:removed 事件与 sidecar 清理", async () => {
  const sid = "session-residfin000-0000-0000-0000-000000000001";
  const dir = join(sessionsBase, "--proj--", sid);
  makeSession(sid, 16);
  writeFileSync(pendingPath, JSON.stringify([sid], null, 2));
  const forgotten = [];
  const m = await freshModule();
  const ctxArgs = {
    archivedIds: [],
    sessionIds: [],
    get: { turnReview: { forget: (id) => forgotten.push(id) } },
  };
  m.apply(makeCtx(ctxArgs));
  const sweepCtx = makeCtx(ctxArgs);
  await m.processPendingDeletes(sweepCtx, true);
  assert.ok(!existsSync(dir), "残留目录应被清扫");
  assert.deepEqual(forgotten, [sid], "残留清扫应补齐 turn-review forget");
  assert.ok(
    sweepCtx.emitted.some(([event, payload]) => event === "api-session/removed" && payload === sid),
    "残留清扫应补齐 api-session/removed",
  );
  assert.deepEqual(JSON.parse(readFileSync(pendingPath, "utf8")), [], "队列条目应在收尾后移除");
});
