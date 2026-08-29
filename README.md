# dsh-archived-conversation

[简体中文](README.zh-CN.md) | English

[![npm version](https://img.shields.io/npm/v/dsh-archived-conversation)](https://www.npmjs.com/package/dsh-archived-conversation)
[![GitHub release](https://img.shields.io/github/v/release/Li-canghai/dsh-archived-conversation)](https://github.com/Li-canghai/dsh-archived-conversation/releases/latest)

An **archived-conversation manager** plugin for DeepSeek Harness (DSH). It adds a **Settings → 已归档 (Archived)** page where archived conversations can be searched, browsed by project, unarchived, or deleted.

DSH already ships the *archive* capability (right-click a conversation in the left sidebar → Archive; the conversation disappears from the workspace view and its id is written to `archivedSessionIds` in `~/.dsh/storages/workspace.json`). But DSH currently has **no** management UI for archived conversations and **no** unarchive / delete entry point — this plugin fills that gap.

## Features

- **Grouped by project** — reuses DSH's workspace info to group archived conversations under their owning project.
- **Instant search** — filters archived conversations by title, project name, or session ID in the browser, without additional session-log reads.
- **Unarchive** — removes the id from `archivedSessionIds`; the conversation returns to its original position in its workspace.
- **Delete** — detaches from the workspace, drops from the archive set, and removes the on-disk session directory (irreversible).
- **OpenViking delete linkage** (0.2.4+) — when an archived conversation is deleted, the matching OpenViking session record (`dsh-<session-id>`, including un-refined content) is deleted too; **refined long-term memories are never touched**.
- Auto-refreshes every 20 seconds and immediately whenever the window regains focus.

## OpenViking delete linkage (0.2.4+)

- **Behavior**: the delete confirmation dialog notes that the OpenViking session record and un-refined content will be removed; after a successful local delete, the result area shows the OpenViking cleanup status:
  - `deleted` → OpenViking record deleted
  - `queued` → cleanup failed for now; queued and retried at next DSH start / settings page open
  - `skipped` → OpenViking not configured; local-only delete
- **Failure safety**: with credentials present, a failed delete request (network/server) is recorded in `~/.dsh/archived-conversation-ov-pending.json` and replayed at **boot, on the 20s timer, and when the settings page opens** until it succeeds (404 counts as success); failures persist without ever blocking the local delete.
- **Not configured** (no `OPENVIKING_*` env or `~/.openviking/ovcli.conf` api_key) → **zero linkage**: no delete, no queue, no error.
- **Switch**: env `DSH_ARCHIVED_CONVERSATION_OV_LINK` (default `true`; `0` or `false` disables linkage and replay).
- **Credential chain** (same as `@openviking/dsh-memory-plugin`): `OPENVIKING_URL`/`OPENVIKING_API_KEY`/`OPENVIKING_ACCOUNT`/`OPENVIKING_USER` env → `~/.openviking/ovcli.conf` → default endpoint `http://127.0.0.1:1933`.
- **Boundary**: target is only the OpenViking session subtree (`DELETE /api/v1/sessions/dsh-<id>`); refined memories under `memories/` are never touched.

## How it works

- Pure ESM, zero runtime dependencies (Node built-ins only), same shape as `dsh-mcp-manager`.
- Client: registers the "已归档" tab via the `settings.section` slot, rendered with `react.createElement` (no JSX, no bundler).
- Host: mounts the `/archived-conversation/api/*` same-origin JSON API via `ctx.webServer.register`.
- Performance: each refresh performs one parallel `stat` per archived log and reuses workspace/file metadata; title-cache hits skip header reads, while concurrent refreshes share one list rebuild.
- Reuses DSH's own services; **never parses the session file format**:
  - `ctx.workspaceRegistry` — the authority on archive state and project membership.
  - `ctx.sessionPersistence.readFrom` — reads each archived session's log and folds its last `session/title` event (the same logic as DSH's own "title" projection unit; `sessionQuery.readTitleSnapshots` is unreliable for cold persisted sessions).
  - `ctx.webServer` — mounts the management API.
- Guard rails: mutation requests require a same-origin Origin, JSON Content-Type, and loopback Host; a running session is queued instead of torn down mid-turn. An idle attached session is released, then deleted.
- Title lookup is compatible with DSH `0.1.2-alpha.1`: it uses only `cachedSnapshot(header)`, then one persistence read. It does not call `coldSnapshot(id)`, whose signature changed in that release.

## Install / Update

Requires [DeepSeek Harness](https://www.deepseek.com/harness/) and **pnpm** on PATH (`dsh plugin` forwards to it).

Install:

```sh
dsh plugin --profile web add dsh-archived-conversation@latest
```

If `dsh` is not on PATH:

```sh
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-archived-conversation@latest
```

Update:

```sh
dsh plugin --profile web update dsh-archived-conversation@latest
```

Then restart `dsh --profile web` and reload the page. The plugin self-activates through `dsh.bundle.patch`; no manual `cordis.patch.yml` edits needed. This plugin has no native build scripts, so `pnpm approve-builds` is not required.

If pnpm 11 reports `minimum release age` (the version is younger than 24h), pin the exact version:

```sh
dsh plugin --profile web add dsh-archived-conversation@0.2.4
```

GitHub Release tarball (prebuilt, no npm):

```sh
dsh plugin --profile web add https://github.com/Li-canghai/dsh-archived-conversation/releases/latest/download/dsh-archived-conversation.tgz
```

## Usage

1. In the left sidebar, right-click any conversation → **Archive** (provided natively by DSH).
2. Open **Settings → 已归档**: browse by project or search by title, project name, or session ID.
3. For each matching conversation you can:
   - **Unarchive** — return it to its original workspace position.
   - **Delete** — remove it permanently (confirmation dialog; irreversible).

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/archived-conversation/api/ping` | Liveness probe (no Origin required) |
| GET | `/archived-conversation/api/list` | Archived conversations grouped by project (no Origin required) |
| POST | `/archived-conversation/api/:id/unarchive` | Unarchive (same-origin Origin + JSON Content-Type + loopback Host) |
| DELETE | `/archived-conversation/api/:id` | Delete (same-origin Origin + JSON Content-Type + loopback Host) |

## Layout

```text
dsh-archived-conversation/
  package.json        # dsh.client.inject + dsh.bundle.patch
  cordis.patch.yml    # plugin row (activated by bundle.patch)
  lib/index.js        # host: API + archive-state read/write
  lib/ov-delete.mjs   # host: OpenViking session-delete linkage (credentials + pending-queue replay)
  lib/client.js       # client: Settings "已归档" UI
  README.md / README.zh-CN.md / LICENSE
```

## Verification

No build step. After installing into a live web profile, open **Settings → 已归档** in the browser. Host liveness: `GET /archived-conversation/api/ping`.

## Local development and deployment

Local status (2026-08-29): source and deployment copies are both `0.2.4`; the web profile is registered through `link:/home/canghai/.dsh/plugins/dsh-archived-conversation`.

The development checkout is `/home/canghai/Project/DSH/Plugins/dsh-archived-conversation`; DSH loads only the self-contained copy at `~/.dsh/plugins/dsh-archived-conversation`. The host must keep `workspaceRegistry`, `sessionQuery`, `sessionPersistence`, and `webServer` in `inject`. It uses DSH services instead of decoding `session.jsonl.zstd` directly.

Deletion is deliberately conservative: archived IDs are updated through `workspaceRegistry.enqueueOperation`; attached sessions enter the delayed-delete queue; sidecars owned by Turn Review and Turn Rewind are purged through their public services when available. Closing a tab is not conversation deletion.

After editing, run `npm test` plus `node --check lib/index.js lib/client.js`, copy the managed package files into the deployment directory without hand-editing that directory, register it explicitly, restart `dsh web`, and verify both the ping endpoint and Settings → 已归档. The deployment directory must contain `node_modules/`, even though the plugin has no runtime dependencies.
