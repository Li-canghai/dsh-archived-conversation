# dsh-archived-conversation

[简体中文](README.zh-CN.md) | English

An **archived-conversation manager** plugin for DeepSeek Harness (DSH). It adds a **Settings → 已归档 (Archived)** page where archived conversations can be searched, browsed by project, unarchived, or deleted.

DSH already ships the *archive* capability (right-click a conversation in the left sidebar → Archive; the conversation disappears from the workspace view and its id is written to `archivedSessionIds` in `~/.dsh/storages/workspace.json`). But DSH currently has **no** management UI for archived conversations and **no** unarchive / delete entry point — this plugin fills that gap.

## Features

- **Grouped by project** — reuses DSH's workspace info to group archived conversations under their owning project.
- **Instant search** — filters archived conversations by title, project name, or session ID in the browser, without additional session-log reads.
- **Unarchive** — removes the id from `archivedSessionIds`; the conversation returns to its original position in its workspace.
- **Delete** — detaches from the workspace, drops from the archive set, and removes the on-disk session directory (irreversible).
- Auto-refreshes every 20 seconds and immediately whenever the window regains focus.

## How it works

- Pure ESM, zero runtime dependencies (Node built-ins only), same shape as `dsh-mcp-manager`.
- Client: registers the "已归档" tab via the `settings.section` slot, rendered with `react.createElement` (no JSX, no bundler).
- Host: mounts the `/archived-conversation/api/*` same-origin JSON API via `ctx.webServer.register`.
- Performance: each refresh performs one parallel `stat` per archived log and reuses workspace/file metadata; title-cache hits skip header reads, while concurrent refreshes share one list rebuild.
- Reuses DSH's own services; **never parses the session file format**:
  - `ctx.workspaceRegistry` — the authority on archive state and project membership.
  - `ctx.sessionPersistence.readFrom` — reads each archived session's log and folds its last `session/title` event (the same logic as DSH's own "title" projection unit; `sessionQuery.readTitleSnapshots` is unreliable for cold persisted sessions).
  - `ctx.webServer` — mounts the management API.
- Guard rails: mutation requests require a same-origin Origin, JSON Content-Type, and loopback Host; sessions still in use are queued for deferred deletion instead of being corrupted.

## Install

```sh
npx -p @deepseek-ai/dsh dsh plugin --profile web add <path-or-repo>
```

Then restart `dsh --profile web` and reload the page. The plugin self-activates through `dsh.bundle.patch`; no manual `cordis.patch.yml` edits needed.

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

```
dsh-archived-conversation/
  package.json        # dsh.client.inject + dsh.bundle.patch
  cordis.patch.yml    # plugin row (activated by bundle.patch)
  lib/index.js        # host: API + archive-state read/write
  lib/client.js       # client: Settings "已归档" UI
  README.md / README.zh-CN.md / LICENSE
```

## Verification

No build step. After installing into a live web profile, open **Settings → 已归档** in the browser. Host liveness: `GET /archived-conversation/api/ping`.
