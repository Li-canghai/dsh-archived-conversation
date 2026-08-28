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

GitHub Release tarball (no npm):

```sh
dsh plugin --profile web add https://github.com/Li-canghai/dsh-archived-conversation/releases/latest/download/dsh-archived-conversation.tgz
```

Restart `dsh --profile web` after installing or updating.

## What's New

- **DSH 0.1.2-alpha.1 title lookup** — stop calling `sessionProjectionCache.coldSnapshot(id)`, whose signature changed in that release. Titles still use the zero-I/O `cachedSnapshot(header)` fast path, then one persistence read.
- **Client inject** — drop the unused `@deepseek-ai/dsh-client-runtime` entry from `dsh.client.inject`.
