// Host half (Node.js) for dsh-archived-conversation.
//
// Exposes a same-origin JSON API under /archived-conversation/api/* that the
// browser client (lib/client.js) drives. It does NOT touch DSH's session file
// format directly: it reads archive membership from the `workspaceRegistry`
// service (the same store DSH's own Settings → workspace UI uses) and removes
// archived conversation directories from disk only on an explicit delete.
//
// Why this is safe:
//   * Archive state lives in `workspaceRegistry.archivedSessionIds` (persisted
//     to ~/.dsh/storages/workspace.json by DSH itself). We only ever *read* it
//     and *rewrite* it through the registry's own `setState`, so live DSH state
//     and the `host/archived-sessions-changed` broadcast stay consistent.
//   * Unarchive = drop the id from `archivedSessionIds`; the session keeps its
//     slot in its workspace's `sessionIds`, so it reappears exactly where it was.
//   * Delete = detach from the owning workspace, drop from `archivedSessionIds`,
//     then remove the on-disk session directory. Active (attached) sessions are
//     refused so we never delete a conversation that is currently open.

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
const PLUGIN_VERSION = "0.1.0";

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function isActive(ctx, id) {
  return ctx.get("sessions")?.get(id) !== undefined;
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

// Rewrite the registry's global archive state through its own operation queue
// (mirroring how the built-in `archiveSession` mutates), so our unarchive/delete
// never interleaves with DSH's own archive operations and loses an update.
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

// Display-title projection mirroring the DSH client runtime: durable log
// title, then the project directory basename, then the raw session id.
function displayTitleOf(title, cwd, id) {
  if (title !== void 0 && title !== "") return title;
  if (cwd !== void 0 && cwd !== "") {
    const base = String(cwd).replace(/[/\\]+$/, "").split(/[/\\]/).pop();
    if (base !== void 0 && base !== "") return base;
  }
  return id;
}

// In-memory caches so the 20s client poll never re-reads session logs.
//  - dirCache:   session id → on-disk session directory (revalidated by stat)
//  - titleCache: session id → { fp, title }, fp = "mtimeMs:size" of the log
//  - listCache:  whole /list response keyed by a cheap fingerprint
const dirCache = new Map();
const titleCache = new Map();
let listCache = { key: null, groups: null };

// Persistent title cache. DSH's JSONL backend has no seek hook, so even a
// "tail" readFrom decompresses the whole zstd log (1.7-4.2s for the large
// archived sessions here). After a plugin restart the in-memory caches are
// empty and the first /list would pay that cost for every session. This file
// survives restarts and is validated by the same cheap "mtimeMs:size" log
// fingerprint, so a cold start serves titles with zero log reads; the slow
// path runs only when a log actually changed (or was never seen).
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

// Debounced write: title reads are rare (only after a fingerprint change), so
// batching a burst costs nothing and keeps the file on disk fresh enough that
// a crash loses at most a couple of titles (re-read on next start).
function scheduleTitlesSave() {
  if (titlesSaveTimer !== null) return;
  titlesSaveTimer = setTimeout(() => {
    titlesSaveTimer = null;
    try {
      // 0600 to match DSH's own storage files: conversation titles are
      // user-private data and must not be world-readable.
      writeFileSync(TITLES_PATH, JSON.stringify(Object.fromEntries(persistedTitles), null, 2), { mode: 0o600 });
    } catch {
      // non-fatal: the cache is an accelerator, re-read on next start
    }
  }, 300);
}

// Persistent queue of deletions that could not complete while the session was
// still attached (DSH keeps agent loops resident). Retried on a timer and once
// at boot; once the session is released (typically after a restart) the delete
// finishes automatically.
const PENDING_PATH = join(homedir(), ".dsh", "archived-conversation-pending.json");
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

// Read the durable title. Fast path first: the host's persisted projection
// cache (`cachedSnapshot`) serves sessions that were active at some point with
// a zero-I/O read; otherwise fold the last `session/title` event from the log
// (the same logic as DSH's own "title" projection unit). `header` is an
// optional already-resolved session header so callers that batch-resolved
// headers once (see listArchived) never make each session re-trigger a
// full `sessionPersistence.list()` index.
async function readLogTitle(ctx, id, header) {
  try {
    const cache = ctx.get("sessionProjectionCache");
    if (cache !== undefined) {
      // 1) Zero-read fast path: the persisted cache row, when the session has
      //    one (archived sessions were active at some point, so they do).
      try {
        const h = header ?? await ctx.workspaceRegistry.readSessionHeader(id);
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
      //    this decompresses the whole log on this platform — only reachable
      //    when the zero-read paths above missed (log changed or new session).
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

// Cached title read: reuses the previous result while the log file is
// unchanged. Looks up the in-memory cache first, then the on-disk persistent
// cache (both keyed by the same "mtimeMs:size" fingerprint), so the slow
// projection/log paths below only run when a log genuinely changed.
async function titleFor(ctx, id, header) {
  const st = await sessionFileStat(id);
  const fp = st ? `${st.mtimeMs}:${st.size}` : "missing";
  const hit = titleCache.get(id);
  if (hit !== undefined && hit.fp === fp) return hit.title;
  const persisted = persistedTitles.get(id);
  if (persisted !== undefined && persisted.fp === fp) {
    titleCache.set(id, persisted);
    return persisted.title;
  }
  const title = await readLogTitle(ctx, id, header);
  const entry = { fp, title };
  titleCache.set(id, entry);
  persistedTitles.set(id, entry);
  scheduleTitlesSave();
  return title;
}

async function listArchived(ctx) {
  // Self-heal: opening the settings page completes any queued deletions whose
  // session has since been released (quick mode keeps the page responsive).
  await processPendingDeletes(ctx, true);

  const registry = ctx.workspaceRegistry;
  const archivedIds = registry.archivedSessionIds;
  if (!archivedIds.length) return { groups: [], pending: [...pendingDeletes] };

  // Cheap fingerprint: the archive set plus each session log's stat. When
  // nothing changed, serve the cached list without reading any log.
  const fpParts = [archivedIds.join(",")];
  for (const id of archivedIds) {
    const st = await sessionFileStat(id);
    fpParts.push(st ? `${id}:${st.mtimeMs}:${st.size}` : `${id}:missing`);
  }
  const key = fpParts.join("|");
  if (listCache.key === key && listCache.groups !== null) {
    return { groups: listCache.groups, pending: [...pendingDeletes] };
  }

  // Titles: fold each archived session's last session/title event in parallel.
  // Resolve every session header first (one shared indexing pass — the first
  // `readSessionHeader` cold-miss fills the registry's header cache, the rest
  // hit it) so the zero-I/O `cachedSnapshot` path can serve all titles
  // without each session independently re-triggering a full `list()`.
  const headers = new Map();
  await Promise.all(
    archivedIds.map(async (id) => {
      try {
        const h = await registry.readSessionHeader(id);
        if (h !== void 0) headers.set(id, h);
      } catch {
        // no persisted log for this slot (e.g. deleted dir, orphaned slot);
        // the slower title paths below handle it
      }
    }),
  );

  const titleMap = {};
  const titleResults = await Promise.all(
    archivedIds.map(async (id) => [id, await titleFor(ctx, id, headers.get(id))]),
  );
  for (const [id, title] of titleResults) {
    if (title !== undefined) titleMap[id] = title;
  }

  const groups = new Map();
  for (const id of archivedIds) {
    const ws = owningWorkspace(ctx, id);
    const rec = ws && (ws.record || ws);
    const project = rec ? rec.title || rec.path || "未知项目" : "未知项目";

    // cwd for the display-title fallback: workspace path, else session header.
    let cwd = rec ? rec.path || null : null;
    if (!cwd) {
      const h = headers.get(id);
      if (h) cwd = h.cwd || null;
    }

    let updatedAt = null;
    const st = await sessionFileStat(id);
    if (st) updatedAt = st.mtimeMs;

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
// the archive set, and remove the on-disk directory. Returns { done: true }
// when the session is gone, or { done: false, error } when DSH refuses to
// release it (the caller queues the id and retries). Never mutates any state
// before the session is actually released.
async function attemptDelete(ctx, id, options = {}) {
  const { quick = false } = options;
  const wasAttached = isActive(ctx, id);
  if (wasAttached) {
    const agent = ctx.get("agents")?.get(id);
    if (agent === void 0 || typeof agent.scope?.dispose !== "function") {
      return { done: false, error: "该对话正在使用中(可能在其他标签页打开)" };
    }
    // Right after a turn ends the agent may still be settling back to idle;
    // give it a short grace window before tearing the loop down. Background
    // sweeps use quick mode and skip the wait (they retry on the next pass).
    if (agent.status === "running") {
      if (quick) return { done: false, error: "该对话正在执行任务" };
      const deadline = Date.now() + 10000;
      while (agent.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (agent.status === "running") {
        return { done: false, error: "该对话正在执行任务" };
      }
    }
    try {
      await agent.scope.dispose();
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: dispose failed for ${id}: ${e}`);
      return { done: false, error: "无法释放该会话" };
    }
    // Verify the teardown actually detached the session before touching state.
    const verifyLimit = quick ? 10 : 30;
    for (let i = 0; i < verifyLimit && isActive(ctx, id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isActive(ctx, id)) {
      ctx.logger?.warn(`archived-conversation: session ${id} survived dispose; deferring delete`);
      return { done: false, error: "该会话仍在使用中" };
    }
    ctx.logger?.info(`archived-conversation: disposed attached session ${id}`);
  }

  const registry = ctx.workspaceRegistry;
  const ws = owningWorkspace(ctx, id);
  if (ws) {
    const wid = (ws.record?.id) || ws.id;
    try {
      await registry.get(wid).detachSession(id);
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: detach failed for ${id}: ${e}`);
    }
  }

  await rewriteArchived(ctx, (s) => ({
    ...s,
    archivedSessionIds: s.archivedSessionIds.filter((x) => x !== id),
  }));

  // The persistence layer may materialize the session log only during retire,
  // so for a just-disposed session sweep a few times — its directory can
  // appear late. Cold sessions already have their directory (or never did).
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

  // Tell the workspace UI the session is gone so its row disappears at once —
  // removing the files alone emits no DSH event, which would leave a stale
  // "ungrouped" entry. Every session/disposed listener either guards by
  // session-object identity (a minimal payload is a no-op) or only reads
  // `session.id`, so this is safe. Attached deletions already emitted
  // session/disposed through the loop teardown above.
  if (!isActive(ctx, id)) {
    try {
      ctx.emit("session/disposed", { id });
    } catch (e) {
      ctx.logger?.warn(`archived-conversation: dispose emit failed: ${e}`);
    }
  }

  // Drop plugin caches so the next /list re-enumerates cleanly.
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
  // session is released — usually right after a restart, when the boot sweep
  // and the 20s timer finish it.
  pendingDeletes.add(id);
  savePendingDeletes();
  return { ok: false, error: `${outcome.error},已安排自动删除;会话释放后(通常重启 DSH 后)将自动完成。` };
}

// Retry deferred deletions: once DSH releases a session (usually at restart),
// the pending delete completes. Runs on a timer, once at plugin boot, and as a
// quick pass whenever the settings page is opened. `quick` skips the long
// grace wait so the page never hangs on a still-running session.
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
  // Deferred-delete queue: finish deletions DSH would not release while the
  // session was attached. Sweep a few staggered times at boot (sessions are
  // cold right after a restart, but the browser may reconnect and re-attach
  // one quickly, so retry), then on a 20s timer.
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

  const route = ctx.webServer.register({
    kind: "prefix",
    path: "/archived-conversation/api",
    async handler(req, res) {
      const url = new URL(req.url, "http://localhost");
      // The prefix route keeps the full path (DSH does not strip it), so slice
      // our own API prefix to get the sub-path the routes below match against.
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
        const unarchiveMatch = rest.match(/^\/([A-Za-z0-9_-]+)\/unarchive$/);
        if (req.method === "POST" && unarchiveMatch) {
          return json(res, 200, await unarchive(ctx, unarchiveMatch[1]));
        }
        const idMatch = rest.match(/^\/([A-Za-z0-9_-]+)$/);
        if (req.method === "DELETE" && idMatch) {
          return json(res, 200, await removeSession(ctx, idMatch[1]));
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
