# vX.Y.Z

## Install / update

Install the `dsh-archived-conversation` plugin on [DeepSeek Harness](https://www.deepseek.com/harness/) from [npm](https://www.npmjs.com/package/dsh-archived-conversation):

```sh
dsh plugin --profile web add dsh-archived-conversation@latest
```

Update:

```sh
dsh plugin --profile web update dsh-archived-conversation@latest
```

If pnpm 11 reports `minimum release age`, pin the exact version:

```sh
dsh plugin --profile web add dsh-archived-conversation@0.2.10
```

GitHub Release tarball (no npm):

```sh
dsh plugin --profile web add https://github.com/Li-canghai/dsh-archived-conversation/releases/latest/download/dsh-archived-conversation.tgz
```

Restart `dsh --profile web` after installing or updating.

## What's New

- **Desktop support** — the management API now mounts as exact Fetch routes on the shared Connection `/api` channel via a scoped `ctx.inject(["connection"])` (top-level injection is down to `workspaceRegistry`). The web profile serves it through the webserver bridge and the Desktop host through Electron's byte pipe, so the same Settings page and API work on both hosts.
- **POST-body mutation endpoints** — `/unarchive` and `/delete` are now `POST /api/archived-conversation/{unarchive,delete}` routes taking a `{ "id": "<sessionId>" }` JSON body; the old DELETE-with-path-param endpoints are gone. Mutations reject cross-origin Origins and require a JSON Content-Type; the loopback trust fence is applied upstream by the webserver bridge / Desktop pipe.
- **Requires DSH 0.1.5-rc.1+** — title reads go through the zero-I/O `cachedSnapshot` fast path, then `sessionController.inspect(id)` only; the `sessionPersistence.inspect` fallback is removed.
- **Bounded parallelism for large archives** — metadata stats (limit 8) and cold title reads (limit 2) run through worker pools, and directory discovery is a single `readdir` pass instead of per-session per-project probing. The client skips re-renders when polled list data is unchanged.
