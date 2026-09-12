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
dsh plugin --profile web add dsh-archived-conversation@0.2.12
```

GitHub Release tarball (no npm):

```sh
dsh plugin --profile web add https://github.com/Li-canghai/dsh-archived-conversation/releases/latest/download/dsh-archived-conversation.tgz
```

Restart `dsh --profile web` after installing or updating.

## What's New

- **Simplified internals** — the header-access helper, the non-`WeakRef` agent-handle fallback, and the change-ledger manual list/delete fallback are gone: mutation routes read headers through the fetch `Headers` API only, `WeakRef` is assumed, and change-ledger cleanup relies solely on `deleteBySession`.
- **Leaner title cache** — the separate in-memory title layer was removed; the persisted fingerprint-checked title map (`mtimeMs:size`, atomic 0600 writes) is now the single source, and deleting a session drops its cached title.
- **Cleaner OpenViking linkage** — the `X-OpenViking-Actor-Peer` header is no longer sent and the single-writer queue helpers are no longer exported.
- **Consistent mutation errors** — 500 responses now always carry a string `error` message.
- All source files ship without code comments; tests were refactored to the fetch `Request` API with new coverage for cached-title cleanup on delete.
