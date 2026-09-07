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
dsh plugin --profile web add dsh-archived-conversation@0.2.9
```

GitHub Release tarball (no npm):

```sh
dsh plugin --profile web add https://github.com/Li-canghai/dsh-archived-conversation/releases/latest/download/dsh-archived-conversation.tgz
```

Restart `dsh --profile web` after installing or updating.

## What's New

- **Crash-safe persisted state** — the title cache and pending-delete queue are now written atomically (temp file + rename), so a crash can no longer truncate them into a cold rebuild or a silently dropped delete.
- **Single-writer delete queues** — deferred local deletes and OpenViking pending deletes are serialized through one in-process promise chain each; overlapping sweeps (20s timer, boot staggering, settings page) can no longer overwrite each other's queue updates.
- **Memory-safe agent handle registry** — captured `AgentHandle` references use `WeakRef`, so disposed agents no longer pin their session object graph; stale entries are swept automatically and factory wrapping now survives read-only Cordis proxies.
- **Faster /list** — file metadata is resolved once per session in parallel, concurrent list requests share a single rebuild, and session headers are read only on title-cache misses.
