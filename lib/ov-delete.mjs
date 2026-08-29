// OpenViking session-delete linkage for dsh-archived-conversation.
//
// When an archived conversation is deleted, the corresponding OpenViking
// session record (`dsh-<session-id>`, the mapping used by
// @openviking/dsh-memory-plugin runtime.mjs `deriveHarnessSessionId("dsh-", id)`)
// is deleted too, so "delete conversation" stays consistent across both stores.
//
// Behavior (see SPEC-openviking-delete-link.md §8):
// - No OpenViking credentials → skip entirely (no delete, no queue).
// - DELETE 404 → treated as success (nothing to clean).
// - Transient failure → one retry → persistent pending-queue entry, replayed
//   on next DSH boot / timer / settings page open until it succeeds.
// - Never throws; the local session deletion is never blocked by this.

// Session-id prefix on the OpenViking side; keep in sync with
// @openviking/dsh-memory-plugin runtime.mjs:40.
import path from "node:path";
import { readFileSync } from "node:fs";

export const OV_SESSION_ID_PREFIX = "dsh-";
export const OV_DEFAULT_ENDPOINT = "http://127.0.0.1:1933";
export const OV_PENDING_FILE = "archived-conversation-ov-pending.json";
const OV_REQUEST_TIMEOUT_MS = 5000;
const OV_RETRY_DELAY_MS = 2000;

// --- credential resolution -------------------------------------------------

// Resolution chain (mirrors @openviking/dsh-memory-plugin):
// OPENVIKING_* env → ~/.openviking/ovcli.conf → default local endpoint.
// Returns null when no usable configuration exists.
export function resolveOvCredentials(env = process.env, readFile = defaultReadFile) {
  const apiKey = env.OPENVIKING_API_KEY || env.OPENVIKING_BEARER_TOKEN;
  if (apiKey) {
    return {
      url: env.OPENVIKING_URL || env.OPENVIKING_BASE_URL || OV_DEFAULT_ENDPOINT,
      apiKey,
      account: env.OPENVIKING_ACCOUNT,
      user: env.OPENVIKING_USER,
    };
  }
  // Fallback to ovcli.conf (JSON: url / api_key / account / user).
  const confPath = joinHome(".openviking", "ovcli.conf");
  const parsed = readConf(confPath, readFile);
  if (parsed?.api_key) {
    return {
      url: parsed.url || OV_DEFAULT_ENDPOINT,
      apiKey: parsed.api_key,
      account: parsed.account,
      user: parsed.user,
    };
  }
  return null;
}

// Production default: read ovcli.conf straight from disk. Tests inject a mock.
function defaultReadFile(filePath, encoding) {
  return readFileSync(filePath, encoding);
}

function joinHome(...parts) {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  return [home, ...parts].join("/");
}

function readConf(path, readFile) {
  if (typeof readFile !== "function") return null;
  try {
    const raw = readFile(path, "utf8");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// --- delete call -----------------------------------------------------------

function buildHeaders(creds, actorPeerId) {
  const headers = { "Content-Type": "application/json" };
  headers.Authorization = `Bearer ${creds.apiKey}`;
  if (creds.account) headers["X-OpenViking-Account"] = creds.account;
  if (creds.user) headers["X-OpenViking-User"] = creds.user;
  if (actorPeerId) headers["X-OpenViking-Actor-Peer"] = actorPeerId;
  return headers;
}

async function callDeleteOne(endpoint, sessionId, creds, fetchImpl, logger) {
  const url = `${endpoint}/api/v1/sessions/${encodeURIComponent(sessionId)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OV_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: "DELETE",
      headers: buildHeaders(creds),
      signal: controller.signal,
    });
    // DELETE has no JSON body by default; 2xx and 404 both mean "nothing left".
    return { ok: res.ok || res.status === 404, status: res.status };
  } catch (error) {
    logger?.warn?.(
      `ov-delete: DELETE ${sessionId} network error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

// Delete the OpenViking session for one DSH session id. Returns:
// { status: "deleted" }   deleted or 404
// { status: "skipped" }   no credentials configured
// { status: "queued" }    failed after retry, persisted for later replay
export async function deleteOpenVikingSession(options = {}) {
  const {
    sessionId,
    env = process.env,
    fetchImpl = globalThis.fetch,
    readFile = defaultReadFile,
    store = pendingStore(),
    logger = null,
    retryDelayMs = OV_RETRY_DELAY_MS,
  } = options;
  if (!sessionId) return { status: "skipped", reason: "no-session-id" };

  const creds = resolveOvCredentials(env, readFile);
  if (!creds) return { status: "skipped", reason: "no-credentials" };

  const ovSessionId = `${OV_SESSION_ID_PREFIX}${sessionId}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await callDeleteOne(creds.url, ovSessionId, creds, fetchImpl, logger);
    if (result.ok) return { status: "deleted" };
    if (attempt === 0) await sleep(retryDelayMs);
  }
  await pushOvPendingDelete({ sessionId: ovSessionId, store, logger });
  return { status: "queued" };
}

// --- pending queue ---------------------------------------------------------

export function pendingStore(file = joinHome(".dsh", OV_PENDING_FILE), fsImpl = null) {
  return {
    file,
    async load() {
      const fs = fsImpl || (await importDefaultFs());
      try {
        const raw = fs.readFileSync(file, "utf8");
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    },
    async save(entries) {
      const fs = fsImpl || (await importDefaultFs());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(entries, null, 2), "utf8");
    },
  };
}

async function importDefaultFs() {
  return await import("node:fs");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pushOvPendingDelete({ sessionId, store = pendingStore(), logger = null }) {
  try {
    const entries = await store.load();
    if (entries.some((e) => e.sessionId === sessionId)) return;
    entries.push({ sessionId, addedAt: Date.now(), attempts: 0 });
    await store.save(entries);
    logger?.info?.(`ov-delete: queued OpenViking session delete for ${sessionId}`);
  } catch (error) {
    logger?.warn?.(`ov-delete: failed to persist pending delete: ${error}`);
  }
}

// Replay pending deletions. Success or 404 removes the entry; transient
// failures keep it for the next flush. Never throws.
export async function flushPendingOvDeletes(options = {}) {
  const {
    env = process.env,
    fetchImpl = globalThis.fetch,
    readFile = defaultReadFile,
    store = pendingStore(),
    logger = null,
  } = options;
  const creds = resolveOvCredentials(env, readFile);
  if (!creds) return 0;

  let entries = [];
  try {
    entries = await store.load();
  } catch {
    return 0;
  }
  if (entries.length === 0) return 0;

  const remaining = [];
  let flushed = 0;
  for (const entry of entries) {
    const result = await callDeleteOne(creds.url, entry.sessionId, creds, fetchImpl, logger);
    if (result.ok) {
      flushed++;
      logger?.info?.(`ov-delete: replayed delete for ${entry.sessionId}`);
    } else {
      remaining.push({ ...entry, attempts: (entry.attempts || 0) + 1 });
    }
  }
  try {
    await store.save(remaining);
  } catch (error) {
    logger?.warn?.(`ov-delete: failed to persist queue after flush: ${error}`);
  }
  return flushed;
}
