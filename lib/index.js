// Host half: same-origin JSON API under /archived-conversation/api/*.
// Archive membership is read/written via the `workspaceRegistry` service (the
// same store DSH's own UI uses), never by touching session files directly;
// disk removal happens only on an explicit delete. Unarchive = drop the id from
// archivedSessionIds (the session keeps its workspace slot). Delete = detach,
// drop from the set, remove the session dir, then drop that session's
// turn-rewind checkpoints and turn-review snapshots. Archive / unarchive leave
// those sidecars alone. Attached idle sessions are released via AgentHandle.dispose
// (captured from agents.create/resume); if the store entry survives, delete is queued.

import { readFileSync, writeFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const name = "archived-conversation";
export const inject = ["workspaceRegistry", "sessionPersistence", "webServer"];

// Paths are overridable via env so tests can run against a temp sandbox;
// production runs without them and uses the default ~/.dsh locations.
const SESSIONS_BASE =
  process.env.ARCHIVED_CONV_SESSIONS_BASE || join(homedir(), ".dsh", "sessions");
const API_PREFIX = "/archived-conversation/api";
const PLUGIN_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** IPv6 Host values must be bracketed (`[::1]:3080`). */
export function parseHostHeader(host) {
  if (typeof host !== "string" || host.length === 0) return null;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 2) return null;
    const hostname = host.slice(1, end);
    const rest = host.slice(end + 1);
    if (rest === "") return { hostname, port: "" };
    if (!rest.startsWith(":")) return null;
    return { hostname, port: rest.slice(1) };
  }
  const colon = host.lastIndexOf(":");
  if (colon === -1) return { hostname: host, port: "" };
  if (host.indexOf(":") !== colon) return null;
  return { hostname: host.slice(0, colon), port: host.slice(colon + 1) };
}

export function isLoopbackHostname(hostname) {
  if (typeof hostname !== "string" || hostname.length === 0) return false;
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "::1") return true;
  const parts = h.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}

/** Origin host must match Host. */
export function isSameOriginMutation(req) {
  const host = req.headers?.host;
  const origin = req.headers?.origin;
  if (typeof host !== "string" || host === "" || typeof origin !== "string" || origin === "") return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function isJsonContentType(req) {
  const contentType = req.headers?.["content-type"];
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("application/json");
}

/** Loopback Host whose port matches the DSH listen port; scheme follows Origin when present. */
export function resolveGuiOrigin(req, listenPort) {
  const hostHeader = req.headers?.host;
  const parsed = parseHostHeader(hostHeader);
  if (parsed === null || !isLoopbackHostname(parsed.hostname)) return null;
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (listenPort !== undefined && port !== listenPort) return null;
  let scheme = "http";
  const originHeader = req.headers?.origin;
  if (typeof originHeader === "string" && originHeader !== "") {
    try {
      const originUrl = new URL(originHeader);
      if (originUrl.protocol === "https:") scheme = "https";
    } catch {
      return null;
    }
  }
  return `${scheme}://${hostHeader}`;
}

function isActive(ctx, id) {
  return ctx.get("sessions")?.get(id) !== undefined;
}

// AgentHandle.dispose is the factory teardown that unregisters the agent AND
// removes the session from ctx.sessions. apiproxy keeps only `.agent` and
// drops the handle, so we wrap create/resume to remember it. agent.scope.dispose
// is only the inner step and leaves the store entry in place until DSH exits.
const AGENT_HANDLE_CAPTURE = Symbol.for("dsh-archived-conversation.agent-handle-capture");
const agentHandles = new Map();

function rememberAgentHandle(handle) {
  const id = handle?.agent?.id;
  if (typeof id !== "string" || id === "" || typeof handle.dispose !== "function") return handle;
  agentHandles.set(id, handle);
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
    // Some Cordis proxies reject extra properties; wrapping still takes effect.
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

// Tear down a live agent+session. Prefer AgentHandle.dispose (drops the store
// entry). Fall back to agent.scope.dispose, which often leaves isActive true.
async function releaseAttachedSession(ctx, id, { quick }) {
  const handle = agentHandles.get(id);
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
      // not this one; keep scanning
    }
  }
  return null;
}

// Rewrite the global archive state through the registry's own operation queue
// (like built-in archiveSession) so our unarchive/delete never interleaves with
// DSH's own archive operations and loses an update.
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
    // header is optional; change-ledger purge is skipped without a cwd
  }
  return null;
}

function optionalService(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

async function purgeTurnReviewSnapshot(ctx, sessionId) {
  const review = optionalService(ctx, "turnReview");
  if (review === undefined || typeof review.forget !== "function") return;
  try {
    await review.forget(sessionId);
  } catch (e) {
    ctx.logger?.warn(`archived-conversation: turn-review forget failed for ${sessionId}: ${e}`);
  }
}

async function purgeChangeLedgerCheckpoints(ctx, sessionId, cwd) {
  const ledger = optionalService(ctx, "changeLedger");
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

// Best-effort: rewind / review are optional plugins (ctx.get, not inject).
// Failures here must not roll back a session that is already detached.
export async function purgeSessionSidecars(ctx, sessionId, cwd) {
  await purgeTurnReviewSnapshot(ctx, sessionId);
  await purgeChangeLedgerCheckpoints(ctx, sessionId, cwd);
}

// Display-title projection mirroring the DSH client: durable log title, then project basename, then raw id.
function displayTitleOf(title, cwd, id) {
  if (title !== void 0 && title !== "") return title;
  if (cwd !== void 0 && cwd !== "") {
    const base = String(cwd).replace(/[/\\]+$/, "").split(/[/\\]/).pop();
    if (base !== void 0 && base !== "") return base;
  }
  return id;
}

// In-memory caches so the 20s client poll never re-reads session logs.
//  - dirCache:   id → session dir (revalidated by stat)
//  - titleCache: id → { fp, title }, fp = "mtimeMs:size"
//  - listCache:  whole /list response keyed by a cheap fingerprint
const dirCache = new Map();
const titleCache = new Map();
let listCache = { key: null, groups: null };
const listInFlight = new WeakMap();

// Persistent title cache: DSH's JSONL backend has no seek hook, so even a tail
// read decompresses the whole zstd log (1.7-4.2s for the large sessions here).
// This file survives restarts, validated by the same "mtimeMs:size" fingerprint,
// so a cold start serves titles with zero log reads; the slow path runs only
// when a log actually changed (or was never seen).
const TITLES_PATH =
  process.env.ARCHIVED_CONV_TITLES_PATH ||
  join(homedir(), ".dsh", "archived-conversation-titles.json");
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

// Debounced save: title reads are rare (only after a fingerprint change), so
// batching loses at most a couple of titles on a crash (re-read on next start).
function scheduleTitlesSave() {
  if (titlesSaveTimer !== null) return;
  titlesSaveTimer = setTimeout(() => {
    titlesSaveTimer = null;
    try {
      // 0600 to match DSH's own storage files: titles are user-private data.
      writeFileSync(TITLES_PATH, JSON.stringify(Object.fromEntries(persistedTitles), null, 2), { mode: 0o600 });
    } catch {
      // non-fatal: the cache is an accelerator, re-read on next start
    }
  }, 300);
}

// Persistent queue of deletions deferred while the session was still attached;
// retried on a timer and once at boot, finishing automatically once released.
const PENDING_PATH =
  process.env.ARCHIVED_CONV_PENDING_PATH ||
  join(homedir(), ".dsh", "archived-conversation-pending.json");
let pendingDeletes = new Set();

function loadPendingDeletes() {
  try {
    const parsed = JSON.parse(readFileSync(PENDING_PATH, "utf8"));
    if (Array.isArray(parsed)) pendingDeletes = new Set(parsed);
  } catch {
    pendingDeletes = new Set();
  }
}

function savePendingDeletes() {
  try {
    writeFileSync(PENDING_PATH, JSON.stringify([...pendingDeletes], null, 2));
  } catch {
    // non-fatal: the queue is advisory and retried from memory anyway
  }
}

// Stat the session log file cheaply; returns null when it is missing.
async function sessionFileStat(id) {
  let dir = dirCache.get(id);
  if (dir === undefined) {
    dir = await findSessionDir(id);
    dirCache.set(id, dir);
  }
  if (!dir) return null;
  try {
    return await stat(join(dir, "session.jsonl.zstd"));
  } catch {
    return null;
  }
}

// Durable title read. Fast path: the persisted projection cache serves
// sessions that were active at some point with zero I/O; else fold the last
// `session/title` event from the log. `headerResolved` distinguishes a missing
// header from one the caller has not attempted to resolve yet.
async function readLogTitle(ctx, id, header, headerResolved = false) {
  try {
    const cache = ctx.get("sessionProjectionCache");
    if (cache !== undefined) {
      // 1) Zero-read fast path: the persisted cache row (archived sessions
      //    were active at some point, so they usually have one).
      try {
        const h = headerResolved ? header : await ctx.workspaceRegistry.readSessionHeader(id);
        if (h !== void 0) {
          const snap = cache.cachedSnapshot(h);
          if (snap && typeof snap.values?.title === "string" && snap.values.title !== "") {
            return snap.values.title;
          }
        }
      } catch (e) {
        ctx.logger?.warn(`archived-conversation: cached title failed for ${id}: ${e}`);
      }
      // 2) Cache plus tail read. NOTE: the JSONL backend has no seek hook, so
      //    this decompresses the whole log — only when the fast paths missed.
      const snap = await cache.coldSnapshot(id);
      if (snap && typeof snap.values?.title === "string" && snap.values.title !== "") {
        return snap.values.title;
      }
    }
  } catch (e) {
    ctx.logger?.warn(`archived-conversation: projection-cache title failed for ${id}: ${e}`);
  }
  try {
    const { events } = await ctx.sessionPersistence.readFrom(id, 0);
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

// Cached title read: reuse the previous result (in-memory, then on-disk, both
// keyed by the same "mtimeMs:size" fingerprint) while the log is unchanged, so
// the slow projection/log paths only run when a log genuinely changed.
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

async function buildArchivedList(ctx) {
  // Self-heal: opening the settings page completes any queued deletions whose
  // session has since been released (quick mode keeps the page responsive).
  await processPendingDeletes(ctx, true);

  const registry = ctx.workspaceRegistry;
  const archivedIds = registry.archivedSessionIds;
  if (!archivedIds.length) return { groups: [], pending: [...pendingDeletes] };

  // Resolve file metadata once and reuse it for the fingerprint, title cache,
  // and updatedAt. Parallel stat calls avoid serial filesystem latency while
  // keeping total I/O at exactly one log stat per archived session.
  const fileStats = new Map(
    await Promise.all(archivedIds.map(async (id) => [id, await sessionFileStat(id)])),
  );
  const fpParts = [archivedIds.join(",")];
  for (const id of archivedIds) {
    const st = fileStats.get(id);
    fpParts.push(st ? `${id}:${st.mtimeMs}:${st.size}` : `${id}:missing`);
  }
  const key = fpParts.join("|");
  if (listCache.key === key && listCache.groups !== null) {
    return { groups: listCache.groups, pending: [...pendingDeletes] };
  }

  // Build session ownership once. The previous per-session list().find(...)
  // repeatedly traversed every workspace and session slot.
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

  // Read headers only for title-cache misses or cwd fallback. A normal warm
  // request with persisted titles and workspace paths needs no header I/O.
  const headerIds = new Set();
  for (const id of archivedIds) {
    const cached = cachedTitleFor(id, fileStats.get(id));
    if (cached === null) headerIds.add(id);
    const ws = workspaceBySession.get(id);
    const rec = ws && (ws.record || ws);
    if (!rec?.path && (cached === null || !cached.title)) headerIds.add(id);
  }
  const headers = new Map();
  await Promise.all(
    [...headerIds].map(async (id) => {
      try {
        const h = await registry.readSessionHeader(id);
        headers.set(id, h);
      } catch {
        // no persisted log for this slot (e.g. deleted dir, orphaned slot);
        // remember the miss so title lookup does not repeat the same I/O
        headers.set(id, undefined);
      }
    }),
  );

  const titleMap = {};
  const titleResults = await Promise.all(
    archivedIds.map(async (id) => [
      id,
      await titleFor(ctx, id, headers.get(id), fileStats.get(id), headers.has(id)),
    ]),
  );
  for (const [id, title] of titleResults) {
    if (title !== undefined) titleMap[id] = title;
  }

  const groups = new Map();
  for (const id of archivedIds) {
    const ws = workspaceBySession.get(id) || null;
    const rec = ws && (ws.record || ws);
    const project = rec ? rec.title || rec.path || "未知项目" : "未知项目";

    // cwd for the display-title fallback: workspace path, else session header.
    let cwd = rec ? rec.path || null : null;
    if (!cwd) {
      const h = headers.get(id);
      if (h) cwd = h.cwd || null;
    }

    const st = fileStats.get(id);
    const updatedAt = st ? st.mtimeMs : null;

    const group = groups.get(project) || { project, sessions: [] };
    group.sessions.push({ id, title: displayTitleOf(titleMap[id], cwd, id), updatedAt });
    groups.set(project, group);
  }

  const sorted = [...groups.values()].map((g) => ({
    ...g,
    sessions: g.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
  }));
  listCache = { key, groups: sorted };
  return { groups: sorted, pending: [...pendingDeletes] };
}

// Poll and focus refreshes can overlap. Share one rebuild per plugin context
// instead of duplicating filesystem and registry work for identical requests.
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
  const state = registry.requireState();
  if (!state.archivedSessionIds.includes(id)) {
    return { ok: false, error: "该对话不在归档列表中" };
  }
  // Unarchiving only restores workspace visibility — safe even while the
  // session is still open (an archived session may remain attached).
  await rewriteArchived(ctx, (s) => ({
    ...s,
    archivedSessionIds: s.archivedSessionIds.filter((x) => x !== id),
  }));
  return { ok: true };
}

// Core deletion: dispose an attached session if needed, then detach, drop from
// the archive set, remove the on-disk directory, and drop that session's
// rewind checkpoints / review snapshots. Returns { done: true } when gone, or
// { done: false, error } when DSH refuses to release it (the caller queues the
// id). Never mutates state before the session is released.
async function attemptDelete(ctx, id, options = {}) {
  const { quick = false } = options;
  const wasAttached = isActive(ctx, id);
  if (wasAttached) {
    const blocked = await releaseAttachedSession(ctx, id, { quick });
    if (blocked) return blocked;
  }

  // Capture cwd before detach: once the session leaves the workspace slot,
  // owningWorkspace can no longer resolve the project path for change-ledger.
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

  // The persistence layer may materialize the session log only during retire,
  // so for a just-disposed session sweep a few times — its directory can
  // appear late; cold sessions already have theirs (or never did).
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
    }
  }

  // Emit session/disposed so the workspace UI drops the row at once — removing
  // files alone emits no DSH event, leaving a stale "ungrouped" entry. Listeners
  // guard by session-object identity or only read session.id, so this is safe;
  // attached deletions already emitted it through the loop teardown above.
  if (!isActive(ctx, id)) {
    try {
      ctx.emit("session/disposed", { id });
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: dispose emit failed: ${e}`);
    }
  }

  // Drop plugin caches so the next /list re-enumerates cleanly.
  await purgeSessionSidecars(ctx, id, cwd);

  dirCache.delete(id);
  titleCache.delete(id);
  persistedTitles.delete(id);
  scheduleTitlesSave();
  listCache = { key: null, groups: null };
  return { done: true };
}

async function removeSession(ctx, id) {
  const state = ctx.workspaceRegistry.requireState();
  if (!state.archivedSessionIds.includes(id)) {
    return { ok: false, error: "该对话不在归档列表中" };
  }
  const outcome = await attemptDelete(ctx, id);
  if (outcome.done) return { ok: true };
  // DSH would not release the session right now (its agent loop stays
  // resident). Queue the id so the delete completes automatically once the
  // session is released — usually right after a restart.
  pendingDeletes.add(id);
  savePendingDeletes();
  return {
    ok: false,
    queued: true,
    error: `${outcome.error},已安排自动删除;会话释放后(通常重启 DSH 后)将自动完成。`,
  };
}

// Retry deferred deletions once DSH releases a session (usually at restart).
// Runs on a timer, once at boot, and as a quick pass when the settings page
// opens; `quick` skips the long grace wait so the page never hangs.
async function processPendingDeletes(ctx, quick = false) {
  if (pendingDeletes.size === 0) return;
  for (const id of [...pendingDeletes]) {
    try {
      const state = ctx.workspaceRegistry.requireState();
      if (!state.archivedSessionIds.includes(id)) {
        pendingDeletes.delete(id);
        continue;
      }
      const outcome = await attemptDelete(ctx, id, { quick });
      if (outcome.done) {
        pendingDeletes.delete(id);
        ctx.logger?.info(`archived-conversation: pending delete completed for ${id}`);
      }
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: pending delete failed for ${id}: ${e}`);
    }
  }
  savePendingDeletes();
}

export function apply(ctx) {
  installHandleCapture(ctx);
  // Deferred-delete queue: finish deletions DSH would not release while the
  // session was attached. Sweep a few staggered times at boot (the browser may
  // reconnect and re-attach one quickly), then on a 20s timer.
  loadPendingDeletes();
  loadTitleCache();
  const pendingTimer = setInterval(() => {
    processPendingDeletes(ctx).catch((e) => ctx.logger?.warn(`archived-conversation: pending sweep failed: ${e}`));
  }, 20000);
  const bootSweep = () => {
    processPendingDeletes(ctx).catch((e) => ctx.logger?.warn(`archived-conversation: boot sweep failed: ${e}`));
  };
  const bootTimers = [1000, 3000, 8000, 20000].map((delay) => setTimeout(bootSweep, delay));
  ctx.effect(() => {
    clearInterval(pendingTimer);
    for (const timer of bootTimers) clearTimeout(timer);
    if (titlesSaveTimer !== null) {
      clearTimeout(titlesSaveTimer);
      titlesSaveTimer = null;
    }
  });

  const listenPort = ctx.webServer.port;
  const route = ctx.webServer.register({
    kind: "prefix",
    path: "/archived-conversation/api",
    async handler(req, res) {
      const url = new URL(req.url, "http://localhost");
      // The prefix route keeps the full path (DSH does not strip it); slice
      // our own prefix to get the sub-path the routes below match against.
      const rest = url.pathname.startsWith(API_PREFIX)
        ? url.pathname.slice(API_PREFIX.length)
        : url.pathname;
      try {
        if (req.method === "GET" && rest === "/ping") {
          return json(res, 200, { ok: true, version: PLUGIN_VERSION });
        }
        if (req.method === "GET" && rest === "/list") {
          return json(res, 200, await listArchived(ctx));
        }
        if (req.method === "POST" || req.method === "DELETE") {
          if (!isSameOriginMutation(req)) {
            return json(res, 403, { error: "cross-origin request rejected" });
          }
          if (!isJsonContentType(req)) {
            return json(res, 415, { error: "A JSON request body is required." });
          }
          if (resolveGuiOrigin(req, listenPort) === null) {
            return json(res, 403, { error: "request origin is not the DSH loopback GUI" });
          }
        }
        const unarchiveMatch = rest.match(/^\/([A-Za-z0-9_-]+)\/unarchive$/);
        if (req.method === "POST" && unarchiveMatch) {
          const result = await unarchive(ctx, unarchiveMatch[1]);
          return json(res, result.ok ? 200 : 404, result);
        }
        const idMatch = rest.match(/^\/([A-Za-z0-9_-]+)$/);
        if (req.method === "DELETE" && idMatch) {
          const result = await removeSession(ctx, idMatch[1]);
          if (result.ok || result.queued) return json(res, 200, result);
          return json(res, 404, result);
        }
        return json(res, 404, { error: "not found" });
      } catch (e) {
        ctx.logger?.error(`archived-conversation api error: ${e?.stack || e}`);
        return json(res, 500, { error: String(e?.message || e) });
      }
    },
  });
  ctx.effect(() => route);
}
