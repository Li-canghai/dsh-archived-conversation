# dsh-archived-conversation

[![npm version](https://img.shields.io/npm/v/dsh-archived-conversation)](https://www.npmjs.com/package/dsh-archived-conversation)
[![GitHub release](https://img.shields.io/github/v/release/Li-canghai/dsh-archived-conversation)](https://github.com/Li-canghai/dsh-archived-conversation/releases/latest)

DeepSeek Harness (DSH) 的**已归档对话管理器**插件。它在 **设置 → 已归档** 中按项目分组列出所有已归档对话,并支持**搜索**、**取消归档**与**删除**。

DSH 本身已经提供"归档"能力(在左侧会话树右键会话即可归档,归档后从工作区视图消失,记录写入 `~/.dsh/storages/workspace.json` 的 `archivedSessionIds`)。但 DSH 目前**没有**已归档对话的管理界面,也没有"取消归档 / 删除已归档"的入口——本插件正是填补这一空缺。

## 功能

- **按项目分组**:复用 DSH 的 workspace 信息,把已归档对话归到其所属项目下展示。
- **子代理会话族**:主对话存在后代时显示可展开箭头;点击整行可查看完整子代理树。子项只读,取消归档与删除统一由主对话管理。
- **即时搜索**:按对话标题、项目名或会话 ID 过滤已归档对话;搜索在浏览器本地完成,不会增加会话日志读取。
- **取消归档**:把对话从 `archivedSessionIds` 移除,对话会回到原工作区的原位置。
- **删除**:从工作区与会话注册表中移除,并删除磁盘上的会话目录(不可恢复)。
- **OpenViking 删除联动**(0.2.4+):删除已归档会话时,同步删除 OpenViking 中对应的会话原始记录(`dsh-<会话ID>`,含未提炼内容);**已提炼的长期记忆不受影响**。
- 设置页每 20 秒自动刷新,窗口重新获得焦点时也会立即刷新。

### OpenViking 删除联动(0.2.4+)

- **行为**:删除确认弹窗会显示"将同时删除 OpenViking 中该会话的记录与未提炼内容";删除成功后,结果区展示 OpenViking 清理状态:
  - `deleted` → 已同步删除 OpenViking 会话记录
  - `queued` → 清理暂时失败,已排队,下次 DSH 启动/设置页打开时自动重试
  - `skipped` → 未配置 OpenViking,仅删除本地会话
- **失败兜底**:有 OpenViking 凭证时,若删除请求失败(网络/服务异常),记录进本地待删队列 `~/.dsh/runtime/dsh-archived-conversation/archived-conversation-ov-pending.json`,在**启动时、20 秒定时、设置页打开**时自动补删直到成功(404 视为成功);失败持久保留,不阻塞本地删除。
- **未配置 OpenViking**(读不到 `OPENVIKING_*` 环境变量或 `~/.openviking/ovcli.conf` 的 api_key)→ **零联动**:不删除、不排队、不报错。
- **开关**:环境变量 `DSH_ARCHIVED_CONVERSATION_OV_LINK`(默认 `true`;设为 `0` 或 `false` 关闭联动与补删)。
- **凭证解析链**(与 `@openviking/dsh-memory-plugin` 一致):`OPENVIKING_URL`/`OPENVIKING_API_KEY`/`OPENVIKING_ACCOUNT`/`OPENVIKING_USER` 环境变量 → `~/.openviking/ovcli.conf` → 默认端点 `http://127.0.0.1:1933`。
- **边界**:目标仅 OpenViking 会话子树(`DELETE /api/v1/sessions/dsh-<id>`);`memories/` 下已提炼记忆永不触碰。

## 实现要点

- 纯 ESM、零运行时依赖(仅用 Node 内置模块),与 `dsh-mcp-manager` 同范式。
- 客户端:通过 `settings.section` 插槽注册"已归档"标签页,用 `react.createElement` 渲染(无 JSX、无打包)。
- 宿主端:通过 `ctx.webServer.register` 挂载 `/archived-conversation/api/*` 同源 JSON API。
- 性能:每轮列表刷新只对每个已归档主会话及其发现的子会话日志执行一次并行 `stat`,复用 workspace 索引与文件元数据;标题缓存命中时跳过 header 读取,并发刷新共享同一次列表重建。
- 全程复用 DSH 既有服务,**不解析会话文件内部格式**:
  - `ctx.workspaceRegistry` —— 归档状态与项目归属的权威来源。
  - `ctx.sessionController.inspect`(0.2.8+,rc.1 起的权威入口;不可用时回退 `ctx.sessionPersistence.inspect`)—— 读取完整逻辑会话日志并折叠最后一条 `session/title` 事件(与 DSH 自身的"title"投影单元同逻辑;`sessionQuery.readTitleSnapshots` 对冷会话不可靠)。
  - `ctx.webServer` —— 挂载管理 API。
- 安全护栏:变更请求要求同源 Origin、JSON Content-Type 和 loopback Host;正在执行任务的会话会延迟删除。空闲但已挂起的会话会释放后立即删除。

- **自0.2.8开始**- 仅支持 DSH `0.1.2-rc.1 及之后版本`。标题读取先走 `cachedSnapshot(header)`,未命中则调用 `sessionController.inspect(id)`(回退 `sessionPersistence.inspect(id)`);不依赖 `readFrom` 的事件序号/日志偏移参数,该参数已分型为独立的 `SessionLogOffset`。

## 安装 / 更新

需要已安装 [DeepSeek Harness](https://www.deepseek.com/harness/),且 PATH 上有 **pnpm**(`dsh plugin` 会转调它)。

安装:

```sh
dsh plugin --profile web add dsh-archived-conversation@latest
```

若没有全局 `dsh`:

```sh
npx -y --package @deepseek-ai/dsh dsh plugin --profile web add dsh-archived-conversation@latest
```

更新已安装的插件:

```sh
dsh plugin --profile web update dsh-archived-conversation@latest
```

随后重启 `dsh --profile web` 并刷新页面。插件通过 `dsh.bundle.patch` 自动激活,无需手动编辑 `cordis.patch.yml`。本插件无原生构建脚本,不必 `pnpm approve-builds`。

若 pnpm 11 提示 `minimum release age`(版本发布不足 24 小时),改为钉死版本:

```sh
dsh plugin --profile web add dsh-archived-conversation@0.2.8
```

也可从 GitHub Release 安装预构建包(不走 npm):

```sh
dsh plugin --profile web add https://github.com/Li-canghai/dsh-archived-conversation/releases/latest/download/dsh-archived-conversation.tgz
```

## 使用

1. 在左侧会话树右键任意会话 → **归档**(由 DSH 原生提供)。
2. 打开 **设置 → 已归档**:按项目查看已归档对话,或在搜索框中输入标题、项目名、会话 ID。
3. 对搜索结果中的每个对话可:
   - **取消归档** —— 主对话及已归档后代一起回到原工作区原位置。
   - **删除** —— 按子级优先彻底移除主对话及完整子代理树(弹窗二次确认,不可恢复)。

子代理对话在本页不提供独立操作;直接对子项调用变更 API 会返回 HTTP 409,要求改由主对话统一管理。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/archived-conversation/api/ping` | 探活(不要求 Origin) |
| GET | `/archived-conversation/api/list` | 按项目分组的已归档对话列表(不要求 Origin) |
| POST | `/archived-conversation/api/:id/unarchive` | 取消归档(需同源 Origin + JSON Content-Type + loopback Host) |
| DELETE | `/archived-conversation/api/:id` | 删除(需同源 Origin + JSON Content-Type + loopback Host) |

## 目录结构

```text
dsh-archived-conversation/
  package.json        # 声明 dsh.client.inject 与 dsh.bundle.patch
  cordis.patch.yml    # 插件行(由 bundle.patch 激活)
  lib/index.js        # 宿主端:API + 归档状态读写
  lib/ov-delete.mjs   # 宿主端:OpenViking 会话删除联动(凭证解析 + 待删队列补删)
  lib/runtime-paths.mjs # 宿主端:运行目录与旧文件迁移
  lib/client.js       # 客户端:设置页"已归档"界面
  README.md / LICENSE
```

## 验证

本插件无需构建步骤。安装到 live web profile 后,在浏览器打开 **设置 → 已归档** 即可验证;宿主 API 探活:`GET /archived-conversation/api/ping`。
`。
