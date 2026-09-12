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
dsh plugin --profile web add dsh-archived-conversation@0.2.11
```

GitHub Release tarball (no npm):

```sh
dsh plugin --profile web add https://github.com/Li-canghai/dsh-archived-conversation/releases/latest/download/dsh-archived-conversation.tgz
```

Restart `dsh --profile web` after installing or updating.

## What's New

- **Safer deferred deletes** — unarchiving now cancels any queued delete for the session family, and the residual sweep only removes the directory of a session that is neither active nor still attached to a workspace slot, so a queued delete can never `rm` a live session's directory.
- **Complete finalization after retries** — when a delete's `rm` initially fails (e.g. a Windows file lock) and the residual sweep later clears the directory, the sweep now also runs the full finalization: OpenViking linkage, the `api-session/removed` event, and turn-rewind/review sidecar plus plugin-cache cleanup.
- **Hardened pending queues** — deferred-delete queue entries are validated against the session-id shape on load, so a corrupt queue file cannot smuggle arbitrary strings into the recursive `rm`; the OpenViking pending queue is now written atomically (tmp + rename, 0600) like the titles cache, and the atomic write helper moved to `lib/runtime-paths.mjs`.
