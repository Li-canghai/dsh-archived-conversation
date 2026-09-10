import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deleteOpenVikingSession, flushPendingOvDeletes } from "./ov-delete.mjs";
import { prepareRuntimeFile } from "./runtime-paths.mjs";

export const name = "archived-conversation";
export const inject = ["workspaceRegistry"];

const SESSIONS_BASE =
  process.env.ARCHIVED_CONV_SESSIONS_BASE || join(homedir(), ".dsh", "sessions");
const PLUGIN_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

const ovLinkEnabled = () => {
  const v = process.env.DSH_ARCHIVED_CONVERSATION_OV_LINK;
  return v !== "0" && v !== "false";
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function headerOf(headers, name) {
  if (headers === undefined || headers === null) return undefined;
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === null ? undefined : value;
  }
  return headers[name];
}

export function isSameOriginMutation(req) {
  const host = headerOf(req?.headers, "host");
  const origin = headerOf(req?.headers, "origin");
  if (typeof host !== "string" || host === "" || typeof origin !== "string" || origin === "") return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function isCrossOriginMutation(req) {
  const origin = headerOf(req?.headers, "origin");
  if (origin === undefined || origin === "") return false;
  return !isSameOriginMutation(req);
}

export function isJsonContentType(req) {
  const contentType = headerOf(req?.headers, "content-type");
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("application/json");
}

function isActive(ctx, id) {
  return ctx.get("sessions")?.get(id) !== undefined;
}

const AGENT_HANDLE_CAPTURE = Symbol.for("dsh-archived-conversation.agent-handle-capture");

const agentHandles = new Map();

function sweepAgentHandles() {
  if (agentHandles.size < 64) return;
  for (const [id, ref] of agentHandles) {
    if (ref.deref() === undefined) agentHandles.delete(id);
  }
}

function rememberAgentHandle(handle) {
  const id = handle?.agent?.id;
  if (typeof id !== "string" || id === "" || typeof handle.dispose !== "function") return handle;
  if (typeof WeakRef === "function") {
    sweepAgentHandles();
    agentHandles.set(id, new WeakRef(handle));
  } else {

    agentHandles.set(id, handle);
  }
  return handle;
}

function wrapAgentFactory(agents, logger) {
  if (agents == null || agents[AGENT_HANDLE_CAPTURE]) return;
  for (const method of ["create", "resume"]) {
    const orig = agents[method];
    if (typeof orig !== "function") continue;
    const wrapped = async function archivedConversationCaptureHandle(...args) {
      return rememberAgentHandle(await orig.apply(this, args));
    };
    try {
      agents[method] = wrapped;
    } catch (assignError) {
      try {
        Object.defineProperty(agents, method, {
          configurable: true,
          writable: true,
          value: wrapped,
        });
      } catch (e) {
        logger?.warn(`archived-conversation: cannot wrap agents.${method}: ${assignError}; ${e}`);
      }
    }
  }
  try {
    agents[AGENT_HANDLE_CAPTURE] = true;
  } catch {

  }
}

function installHandleCapture(ctx) {
  if (typeof ctx.inject !== "function") return;
  ctx.inject(["agents"], (scope) => {
    wrapAgentFactory(scope.agents, ctx.logger);
  });
}

function verifyStepMs() {
  const raw = process.env.ARCHIVED_CONV_VERIFY_STEP_MS;
  if (raw === undefined || raw === "") return 100;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 100;
}

async function waitWhileRunning(agent, quick) {
  if (agent?.status !== "running") return null;
  if (quick) return { done: false, error: "该对话正在执行任务" };
  const deadline = Date.now() + 10000;
  while (agent.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (agent.status === "running") {
    return { done: false, error: "该对话正在执行任务" };
  }
  return null;
}

async function releaseAttachedSession(ctx, id, { quick }) {
  const stored = agentHandles.get(id);
  const handle = stored && typeof stored.deref === "function" ? stored.deref() : stored;
  const agent = handle?.agent ?? ctx.get("agents")?.get(id);
  if (handle !== undefined && typeof handle.dispose === "function") {
    const running = await waitWhileRunning(agent, quick);
    if (running) return running;
    try {
      await handle.dispose();
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: handle.dispose failed for ${id}: ${e}`);
      return { done: false, error: "无法释放该会话" };
    } finally {
      agentHandles.delete(id);
    }
  } else {
    if (agent === void 0 || typeof agent.scope?.dispose !== "function") {
      return { done: false, error: "该对话正在使用中(可能在其他标签页打开)" };
    }
    const running = await waitWhileRunning(agent, quick);
    if (running) return running;
    try {
      await agent.scope.dispose();
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: dispose failed for ${id}: ${e}`);
      return { done: false, error: "无法释放该会话" };
    }
  }
  const verifyLimit = quick ? 10 : 30;
  const stepMs = verifyStepMs();
  for (let i = 0; i < verifyLimit && isActive(ctx, id); i++) {
    if (stepMs > 0) await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  if (isActive(ctx, id)) {
    ctx.logger?.warn(`archived-conversation: session ${id} survived dispose; deferring delete`);
    return { done: false, error: "该会话仍在使用中" };
  }
  ctx.logger?.info(`archived-conversation: disposed attached session ${id}`);
  return null;
}

async function findSessionDir(id) {
  let entries;
  try {
    entries = await readdir(SESSIONS_BASE);
  } catch {
    return null;
  }
  for (const projectDir of entries) {
    const candidate = join(SESSIONS_BASE, projectDir, id);
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {

    }
  }
  return null;
}

function rewriteArchived(ctx, mutate) {
  const registry = ctx.workspaceRegistry;
  return registry.enqueueOperation(async () => {
    const state = registry.requireState();
    await registry.setState(mutate(state));
  });
}

function owningWorkspace(ctx, id) {
  const registry = ctx.workspaceRegistry;
  return registry.list().find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(id)) || null;
}

function workspacePathOf(ws) {
  const rec = ws && (ws.record || ws);
  if (typeof rec?.path === "string" && rec.path !== "") return rec.path;
  return null;
}

async function resolveSessionCwd(ctx, id) {
  const fromWs = workspacePathOf(owningWorkspace(ctx, id));
  if (fromWs) return fromWs;
  try {
    const header = await ctx.workspaceRegistry.readSessionHeader(id);
    if (typeof header?.cwd === "string" && header.cwd !== "") return header.cwd;
  } catch {

  }
  return null;
}

async function inspectSessionLog(ctx, id) {
  const controller = ctx.get("sessionController");
  if (typeof controller?.inspect !== "function") return undefined;
  return await controller.inspect(id);
}

async function purgeTurnReviewSnapshot(ctx, sessionId) {
  const review = ctx.get("turnReview");
  if (review === undefined || typeof review.forget !== "function") return;
  try {
    await review.forget(sessionId);
  } catch (e) {
    ctx.logger?.warn(`archived-conversation: turn-review forget failed for ${sessionId}: ${e}`);
  }
}

async function purgeChangeLedgerCheckpoints(ctx, sessionId, cwd) {
  const ledger = ctx.get("changeLedger");
  if (ledger === undefined) return;
  if (typeof ledger.deleteBySession === "function") {
    try {
      await ledger.deleteBySession({
        sessionId,
        ...(typeof cwd === "string" && cwd !== "" ? { cwd } : {}),
      });
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: change-ledger deleteBySession failed for ${sessionId}: ${e}`);
    }
    return;
  }
  if (typeof cwd !== "string" || cwd === "") return;
  if (typeof ledger.list !== "function" || typeof ledger.delete !== "function") return;
  let points;
  try {
    points = await ledger.list({
      cwd,
      includeRescue: true,
      includeTurnCheckpoints: true,
    });
  } catch (e) {
    ctx.logger?.warn(`archived-conversation: change-ledger list failed for ${sessionId}: ${e}`);
    return;
  }
  if (!Array.isArray(points)) return;
  for (const point of points) {
    if (!point || point.sessionId !== sessionId || typeof point.id !== "string" || point.id === "") continue;
    const restoreCwd = typeof point.workspace === "string" && point.workspace !== "" ? point.workspace : cwd;
    try {
      await ledger.delete({
        cwd: restoreCwd,
        restorePointId: point.id,
        confirmation: `DELETE ${point.id}`,
      });
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: change-ledger delete failed for ${point.id}: ${e}`);
    }
  }
}

export async function purgeSessionSidecars(ctx, sessionId, cwd) {
  await purgeTurnReviewSnapshot(ctx, sessionId);
  await purgeChangeLedgerCheckpoints(ctx, sessionId, cwd);
}

function displayTitleOf(title, cwd, id) {
  if (title !== void 0 && title !== "") return title;
  if (cwd !== void 0 && cwd !== "") {
    const base = String(cwd).replace(/[/\\]+$/, "").split(/[/\\]/).pop();
    if (base !== void 0 && base !== "") return base;
  }
  return id;
}

const dirCache = new Map();
const titleCache = new Map();
let listCache = { key: null, groups: null };
const listInFlight = new WeakMap();

const TITLES_PATH =
  process.env.ARCHIVED_CONV_TITLES_PATH ||
  prepareRuntimeFile("archived-conversation-titles.json");
let persistedTitles = new Map();
let titlesSaveTimer = null;

function loadTitleCache() {
  try {
    const parsed = JSON.parse(readFileSync(TITLES_PATH, "utf8"));
    if (parsed && typeof parsed === "object") {
      persistedTitles = new Map(
        Object.entries(parsed).filter(
          ([, v]) =>
            v &&
            typeof v.fp === "string" &&
            (v.title === undefined || typeof v.title === "string"),
        ),
      );
    }
  } catch {
    persistedTitles = new Map();
  }
}

function atomicWriteFileSync(target, data, options) {
  const tmp = `${target}.tmp`;
  try {
    writeFileSync(tmp, data, options);
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {

    }
    throw error;
  }
}

function scheduleTitlesSave() {
  if (titlesSaveTimer !== null) return;
  titlesSaveTimer = setTimeout(() => {
    titlesSaveTimer = null;
    try {

      atomicWriteFileSync(TITLES_PATH, JSON.stringify(Object.fromEntries(persistedTitles), null, 2), { mode: 0o600 });
    } catch {

    }
  }, 300);
}

const PENDING_PATH =
  process.env.ARCHIVED_CONV_PENDING_PATH ||
  prepareRuntimeFile("archived-conversation-pending.json");
let pendingDeletes = new Set();

function loadPendingDeletes() {
  try {
    const parsed = JSON.parse(readFileSync(PENDING_PATH, "utf8"));
    if (Array.isArray(parsed)) pendingDeletes = new Set(parsed);
  } catch {
    pendingDeletes = new Set();
  }
}

function savePendingDeletes(logger) {
  try {
    atomicWriteFileSync(PENDING_PATH, JSON.stringify([...pendingDeletes], null, 2), { mode: 0o600 });
  } catch (error) {
    logger?.warn(`archived-conversation: pending-delete queue save failed: ${error}; queued ids are in-memory only and will not survive a restart`);
  }
}

const METADATA_CONCURRENCY = 8;

const TITLE_CONCURRENCY = 2;

async function mapLimited(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]);
    }
  }));
  return results;
}

async function sessionFileStats(ids) {
  const stats = new Map();
  const missing = new Set();
  await mapLimited(ids, METADATA_CONCURRENCY, async (id) => {
    const dir = dirCache.get(id);
    if (dir) {
      try {
        stats.set(id, await stat(join(dir, "session.jsonl.zstd")));
        return;
      } catch {
        dirCache.delete(id);
      }
    }
    stats.set(id, null);
    missing.add(id);
  });
  if (missing.size === 0) return stats;

  let projects;
  try {
    projects = await readdir(SESSIONS_BASE, { withFileTypes: true });
  } catch {
    return stats;
  }
  const discovered = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = join(SESSIONS_BASE, project.name);
    let entries;
    try {
      entries = await readdir(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !missing.has(entry.name)) continue;
      dirCache.set(entry.name, join(projectDir, entry.name));
      missing.delete(entry.name);
      discovered.push(entry.name);
    }
    if (missing.size === 0) break;
  }
  await mapLimited(discovered, METADATA_CONCURRENCY, async (id) => {
    try {
      stats.set(id, await stat(join(dirCache.get(id), "session.jsonl.zstd")));
    } catch {

    }
  });
  return stats;
}

async function readLogTitle(ctx, id, header, headerResolved = false) {
  const cache = ctx.get("sessionProjectionCache");
  if (cache !== undefined && typeof cache.cachedSnapshot === "function") {

    try {
      const h = headerResolved ? header : await ctx.workspaceRegistry.readSessionHeader(id);
      if (h !== void 0) {

        const snap = cache.cachedSnapshot(h, 0, ["title"]);
        if (snap && typeof snap.values?.title === "string" && snap.values.title !== "") {
          return snap.values.title;
        }
      }
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: cached title failed for ${id}: ${e}`);
    }
  }
  try {
    const inspection = await inspectSessionLog(ctx, id);
    const events = inspection?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e && e.type === "session/title" && typeof e.data?.title === "string" && e.data.title !== "") {
        return e.data.title;
      }
    }
  } catch (e) {
    ctx.logger?.warn(`archived-conversation: title read failed for ${id}: ${e}`);
  }
  return undefined;
}

function cachedTitleFor(id, st) {
  const fp = st ? `${st.mtimeMs}:${st.size}` : "missing";
  const hit = titleCache.get(id);
  if (hit !== undefined && hit.fp === fp) return hit;
  const persisted = persistedTitles.get(id);
  if (persisted !== undefined && persisted.fp === fp) {
    titleCache.set(id, persisted);
    return persisted;
  }
  return null;
}

async function titleFor(ctx, id, header, st, headerResolved = false) {
  const cached = cachedTitleFor(id, st);
  if (cached !== null) return cached.title;
  const fp = st ? `${st.mtimeMs}:${st.size}` : "missing";
  const title = await readLogTitle(ctx, id, header, headerResolved);
  const entry = { fp, title };
  titleCache.set(id, entry);
  persistedTitles.set(id, entry);
  scheduleTitlesSave();
  return title;
}

async function subagentChildrenOf(ctx, rootId, options = {}) {
  const { strict = false } = options;
  const subagents = ctx.get("subagents");
  if (typeof subagents?.listDescendants !== "function") return [];
  try {
    const entries = await subagents.listDescendants(rootId);
    return entries
      .filter((entry) => entry?.kind === "child" && typeof entry.id === "string")
      .map((entry) => ({
        id: entry.id,
        parentId: entry.parentId,
        depth: entry.depth,
        title: typeof entry.label === "string" && entry.label !== "" ? entry.label : entry.id,
        mode: entry.mode,
      }));
  } catch (e) {
    ctx.logger?.warn(`archived-conversation: subagent listing failed for ${rootId}: ${e}`);
    if (strict) throw e;
    return [];
  }
}

async function archivedFamilyOwner(ctx, sessionId) {
  for (const rootId of ctx.workspaceRegistry.archivedSessionIds) {
    if (rootId === sessionId) continue;
    const children = await subagentChildrenOf(ctx, rootId, { strict: true });
    if (children.some((child) => child.id === sessionId)) return rootId;
  }
  return null;
}

async function buildArchivedList(ctx) {

  await processPendingDeletes(ctx, true);

  const registry = ctx.workspaceRegistry;
  const archivedIds = registry.archivedSessionIds;
  if (!archivedIds.length) return { groups: [], pending: [...pendingDeletes] };
  const childrenByRoot = new Map(
    await mapLimited(archivedIds, METADATA_CONCURRENCY, async (id) => [id, await subagentChildrenOf(ctx, id)]),
  );
  const childIds = [...new Set([...childrenByRoot.values()].flat().map((child) => child.id))];
  const allSessionIds = [...new Set([...archivedIds, ...childIds])];

  const fileStats = await sessionFileStats(allSessionIds);
  const fpParts = [archivedIds.join(","), JSON.stringify([...childrenByRoot])];
  for (const id of allSessionIds) {
    const st = fileStats.get(id);
    fpParts.push(st ? `${id}:${st.mtimeMs}:${st.size}` : `${id}:missing`);
  }
  const key = fpParts.join("|");
  if (listCache.key === key && listCache.groups !== null) {
    return { groups: listCache.groups, pending: [...pendingDeletes] };
  }

  const archivedSet = new Set(archivedIds);
  const workspaceBySession = new Map();
  for (const workspace of registry.list()) {
    if (!Array.isArray(workspace.sessionIds)) continue;
    for (const id of workspace.sessionIds) {
      if (archivedSet.has(id) && !workspaceBySession.has(id)) {
        workspaceBySession.set(id, workspace);
      }
    }
  }

  const headerIds = new Set();
  for (const id of archivedIds) {
    const cached = cachedTitleFor(id, fileStats.get(id));
    if (cached === null) headerIds.add(id);
    const ws = workspaceBySession.get(id);
    const rec = ws && (ws.record || ws);
    if (!rec?.path && (cached === null || !cached.title)) headerIds.add(id);
  }
  for (const id of childIds) {
    if (cachedTitleFor(id, fileStats.get(id)) === null) headerIds.add(id);
  }
  const headers = new Map();
  await mapLimited(
    [...headerIds], METADATA_CONCURRENCY, async (id) => {
      try {
        const h = await registry.readSessionHeader(id);
        headers.set(id, h);
      } catch {

        headers.set(id, undefined);
      }
    },
  );

  const titleMap = {};
  const titleResults = await mapLimited(
    allSessionIds, TITLE_CONCURRENCY, async (id) => [
      id,
      await titleFor(ctx, id, headers.get(id), fileStats.get(id), headers.has(id)),
    ],
  );
  for (const [id, title] of titleResults) {
    if (title !== undefined) titleMap[id] = title;
  }

  const groups = new Map();
  for (const id of archivedIds) {
    const ws = workspaceBySession.get(id) || null;
    const rec = ws && (ws.record || ws);
    const project = rec ? rec.title || rec.path || "未知项目" : "未知项目";

    let cwd = rec ? rec.path || null : null;
    if (!cwd) {
      const h = headers.get(id);
      if (h) cwd = h.cwd || null;
    }

    const st = fileStats.get(id);
    const updatedAt = st ? st.mtimeMs : null;

    const group = groups.get(project) || { project, sessions: [] };
    const children = (childrenByRoot.get(id) ?? []).map((child) => ({
      ...child,
      title: displayTitleOf(titleMap[child.id] ?? child.title, cwd, child.id),
    }));
    group.sessions.push({
      id,
      title: displayTitleOf(titleMap[id], cwd, id),
      updatedAt,
      children,
    });
    groups.set(project, group);
  }

  const sorted = [...groups.values()].map((g) => ({
    ...g,
    sessions: g.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
  }));
  listCache = { key, groups: sorted };
  return { groups: sorted, pending: [...pendingDeletes] };
}

async function listArchived(ctx) {
  const requestKey = `${ctx.workspaceRegistry.archivedSessionIds.join(",")}|${[...pendingDeletes].join(",")}`;
  const active = listInFlight.get(ctx);
  if (active?.key === requestKey) return active.request;
  const request = buildArchivedList(ctx);
  listInFlight.set(ctx, { key: requestKey, request });
  try {
    return await request;
  } finally {
    if (listInFlight.get(ctx)?.request === request) listInFlight.delete(ctx);
  }
}

async function unarchive(ctx, id) {
  const registry = ctx.workspaceRegistry;
  const owner = await archivedFamilyOwner(ctx, id);
  if (owner !== null) {
    return { ok: false, conflict: true, error: "子代理对话不能单独取消归档,请通过主对话统一管理" };
  }
  const state = registry.requireState();
  if (!state.archivedSessionIds.includes(id)) {
    return { ok: false, error: "该对话不在归档列表中" };
  }

  const familyIds = new Set([id, ...(await subagentChildrenOf(ctx, id, { strict: true })).map((child) => child.id)]);
  await rewriteArchived(ctx, (s) => ({
    ...s,
    archivedSessionIds: s.archivedSessionIds.filter((x) => !familyIds.has(x)),
  }));
  return { ok: true };
}

async function attemptDelete(ctx, id, options = {}) {
  const { quick = false } = options;
  const wasAttached = isActive(ctx, id);
  if (wasAttached) {
    const blocked = await releaseAttachedSession(ctx, id, { quick });
    if (blocked) return blocked;
  }

  const cwd = await resolveSessionCwd(ctx, id);

  const registry = ctx.workspaceRegistry;
  const ws = owningWorkspace(ctx, id);
  if (ws) {
    const wid = (ws.record?.id) || ws.id;
    try {
      await registry.get(wid).detachSession(id);
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: detach failed for ${id}: ${e}`);
      return { done: false, error: "无法从工作区解除该会话" };
    }
  }

  await rewriteArchived(ctx, (s) => ({
    ...s,
    archivedSessionIds: s.archivedSessionIds.filter((x) => x !== id),
  }));

  let dir = await findSessionDir(id);
  if (wasAttached) {
    for (let attempt = 0; attempt < 5 && dir === null; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      dir = await findSessionDir(id);
    }
  }
  if (dir) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (e) {

      ctx.logger?.warn(`archived-conversation: rm failed for ${dir}: ${e}`);
      return {
        done: false,
        error: `会话目录删除失败(${e && e.code ? e.code : "unknown"}),已安排自动重试;文件占用解除后(通常重启 DSH 后)将自动完成。`,
      };
    }
  }

  let ovStatus = "skipped";
  if (ovLinkEnabled()) {
    try {
      const r = await deleteOpenVikingSession({ sessionId: id, logger: ctx.logger });
      ovStatus = r.status;
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: ov delete failed for ${id}: ${e}`);
    }
  }

  if (!wasAttached) {
    try {
      ctx.emit("api-session/removed", id);
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: api removal emit failed: ${e}`);
    }
  }

  await purgeSessionSidecars(ctx, id, cwd);

  dirCache.delete(id);
  titleCache.delete(id);
  persistedTitles.delete(id);
  scheduleTitlesSave();
  listCache = { key: null, groups: null };
  return { done: true, ov: ovStatus };
}

async function removeSession(ctx, id, options = {}) {
  const { quick = false } = options;
  const owner = await archivedFamilyOwner(ctx, id);
  if (owner !== null) {
    return { ok: false, conflict: true, error: "子代理对话不能单独删除,请通过主对话统一管理" };
  }
  const state = ctx.workspaceRegistry.requireState();
  if (!state.archivedSessionIds.includes(id)) {
    return { ok: false, error: "该对话不在归档列表中" };
  }
  const children = await subagentChildrenOf(ctx, id, { strict: true });
  for (const child of [...children].sort((a, b) => b.depth - a.depth)) {
    const childOutcome = await attemptDelete(ctx, child.id, { quick });
    if (!childOutcome.done) {
      pendingDeletes.add(id);
      savePendingDeletes(ctx.logger);
      return {
        ok: false,
        queued: true,
        error: `${childOutcome.error},已安排主对话及其子代理树自动删除;会话释放后(通常重启 DSH 后)将自动完成。`,
      };
    }
  }
  const outcome = await attemptDelete(ctx, id, { quick });
  if (outcome.done) return { ok: true, ov: outcome.ov };

  pendingDeletes.add(id);
  savePendingDeletes(ctx.logger);
  return {
    ok: false,
    queued: true,
    error: `${outcome.error},已安排自动删除;会话释放后(通常重启 DSH 后)将自动完成。`,
  };
}

let pendingSweepTail = Promise.resolve();

export function processPendingDeletes(ctx, quick = false) {
  const run = pendingSweepTail.then(
    () => sweepPendingDeletes(ctx, quick),
    () => sweepPendingDeletes(ctx, quick),
  );

  pendingSweepTail = run.then(() => undefined, () => undefined);
  return run;
}

async function sweepPendingDeletes(ctx, quick) {
  if (pendingDeletes.size === 0) return;
  for (const id of [...pendingDeletes]) {
    try {
      const state = ctx.workspaceRegistry.requireState();
      if (!state.archivedSessionIds.includes(id)) {

        const residualDir = await findSessionDir(id);
        if (residualDir === null) {
          pendingDeletes.delete(id);
          continue;
        }
        try {
          await rm(residualDir, { recursive: true, force: true });
          pendingDeletes.delete(id);
          ctx.logger?.info(`archived-conversation: residual directory cleared for ${id}`);
        } catch (e) {
          ctx.logger?.warn(`archived-conversation: residual directory rm still failing for ${id}: ${e}; will retry`);
        }
        continue;
      }
      const outcome = await removeSession(ctx, id, { quick });
      if (outcome.ok) {
        pendingDeletes.delete(id);
        ctx.logger?.info(`archived-conversation: pending delete completed for ${id}`);
      }
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: pending delete failed for ${id}: ${e}`);
    }
  }
  savePendingDeletes(ctx.logger);
}

export function apply(ctx) {
  installHandleCapture(ctx);

  loadPendingDeletes();
  loadTitleCache();
  const pendingTimer = setInterval(() => {
    processPendingDeletes(ctx).catch((e) => ctx.logger?.warn(`archived-conversation: pending sweep failed: ${e}`));
  }, 20000);
  const bootSweep = () => {
    processPendingDeletes(ctx).catch((e) => ctx.logger?.warn(`archived-conversation: boot sweep failed: ${e}`));
  };
  const bootTimers = [1000, 3000, 8000, 20000].map((delay) => setTimeout(bootSweep, delay));

  const ovSweep = () => {
    if (!ovLinkEnabled()) return;
    flushPendingOvDeletes({ logger: ctx.logger }).catch((e) =>
      ctx.logger?.warn(`archived-conversation: ov pending flush failed: ${e}`),
    );
  };
  const ovTimer = setInterval(ovSweep, 20000);
  const ovTimers = [2000, 8000, 30000].map((delay) => setTimeout(ovSweep, delay));
  ctx.effect(() => {
    clearInterval(ovTimer);
    for (const timer of ovTimers) clearTimeout(timer);
  });
  ctx.effect(() => {
    clearInterval(pendingTimer);
    for (const timer of bootTimers) clearTimeout(timer);
    if (titlesSaveTimer !== null) {
      clearTimeout(titlesSaveTimer);
      titlesSaveTimer = null;
    }
  });

  ctx.inject(["connection"], (connCtx) => {
    const register = (path, methods, fetch) =>
      connCtx.connection.registerFetchRoute(ctx, {
        path: `/api/archived-conversation/${path}`,
        methods,
        requestBody: "buffered",
        fetch,
      });
    register("ping", ["GET"], async () => jsonResponse({ ok: true, version: PLUGIN_VERSION }));
    register("list", ["GET"], async () => {

      ovSweep();
      return jsonResponse(await listArchived(ctx));
    });
    register("unarchive", ["POST"], (request) => mutationApi(request, ctx.logger, (id) => unarchive(ctx, id)));
    register("delete", ["POST"], (request) => mutationApi(request, ctx.logger, (id) => removeSession(ctx, id, { quick: true })));
  });
}

async function mutationApi(request, logger, action) {
  try {
    if (isCrossOriginMutation(request)) {
      return jsonResponse({ error: "cross-origin request rejected" }, 403);
    }
    if (!isJsonContentType(request)) {
      return jsonResponse({ error: "A JSON request body is required." }, 415);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "A JSON request body is required." }, 400);
    }
    const id = body && typeof body === "object" ? body.id : undefined;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
      return jsonResponse({ error: "A valid session id is required." }, 400);
    }
    const result = await action(id);
    if (result.ok || result.queued) return jsonResponse(result, 200);
    return jsonResponse(result, result.conflict ? 409 : 404);
  } catch (e) {
    logger?.error(`archived-conversation api error: ${e?.stack || e}`);
    return jsonResponse({ error: String(e?.message || e) }, 500);
  }
}
