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
dsh plugin --profile web add dsh-archived-conversation@0.2.5
```

GitHub Release tarball (no npm):

```sh
dsh plugin --profile web add https://github.com/Li-canghai/dsh-archived-conversation/releases/latest/download/dsh-archived-conversation.tgz
```

Restart `dsh --profile web` after installing or updating.

## What's New

- **DSH 0.1.2-alpha.3 session delete** — deleting a cold archived session emits the documented `api-session/removed(sessionId)` list event instead of forging an incomplete object for `session/disposed(Session)`.
- **Runtime state directory** — plugin-owned files (`archived-conversation-titles.json`, `archived-conversation-pending.json`, `archived-conversation-ov-pending.json`) now live under `~/.dsh/runtime/dsh-archived-conversation`; existing root-level files are moved once on upgrade when the destination is empty.
