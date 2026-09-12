# dsh-archived-conversation

[![npm version](https://img.shields.io/npm/v/dsh-archived-conversation)](https://www.npmjs.com/package/dsh-archived-conversation)
[![GitHub release](https://img.shields.io/github/v/release/Li-canghai/dsh-archived-conversation)](https://github.com/Li-canghai/dsh-archived-conversation/releases/latest)

DeepSeek Harness (DSH) 的**已归档对话管理器**插件。它在 **设置 → 已归档** 中按项目分组列出所有已归档对话,并支持**搜索**、**取消归档**与**删除**。**0.2.10 起同时支持 Web profile 与 Desktop 桌面端**。

DSH 本身已经提供"归档"能力(在左侧会话树右键会话即可归档,归档后从工作区视图消失,记录写入 `~/.dsh/storages/workspace.json` 的 `archivedSessionIds`)。但 DSH 目前**没有**已归档对话的管理界面,也没有"取消归档 / 删除已归档"的入口——本插件正是填补这一空缺。

## 功能

- **按项目分组**:复用 DSH 的 workspace 信息,把已归档对话归到其所属项目下展示。
- **子代理会话族**:主对话存在后代时显示可展开箭头;点击整行可查看完整子代理树。子项只读,取消归档与删除统一由主对话管理。
- **即时搜索**:按对话标题、项目名或会话 ID 过滤已归档对话;搜索在浏览器本地完成,不会增加会话日志读取。
- **取消归档**:把对话从 `archivedSessionIds` 移除,对话会回到原工作区的原位置。
- **删除**:从工作区与会话注册表中移除,并删除磁盘上的会话目录(不可恢复);正在执行任务的会话会立即返回"已排队"回执,由后台队列在会话释放后自动完成删除。
- **Web / Desktop 双端**(0.2.10+):管理 API 挂载在 Connection 共享 `/api` 通道,不依赖 `webServer` 服务;web profile 走 webserver 桥,Desktop 走 Electron 字节管道,同一套设置页与 API 两端可用。
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

- 客户端:通过 `settings.section` 插槽注册"已归档"标签页,用 `react.createElement` 渲染(无 JSX、无打包);列表数据未变化时跳过重渲染,20 秒轮询与焦点刷新不产生多余 DOM 更新。
- 宿主端:顶层注入仅 `workspaceRegistry`;API 通过 scoped `ctx.inject(["connection"])` 在共享 `/api` 通道注册精确 Fetch 路由(`/api/archived-conversation/*`)。web profile 由 webserver 桥承载(信任围栏与浏览器鉴权在路由之前施加),Desktop 由 Electron 主进程经字节管道送入同一 handler,两端共用一套代码,不再依赖 `webServer` 服务。
- 性能:
  - 元数据读取走有界工作池(stat 并发上限 8,标题慢路径并发上限 2),大归档下不会淹没文件系统队列。
  - 目录发现由一次全量 `readdir` 扫描代替"逐会话逐项目"探测;未命中的缓存按请求局部重试,新建/移动的日志仍能被发现。
  - 持久化标题缓存(`mtimeMs:size` 指纹校验、跨重启生效)命中时零日志读取——DSH 的 JSONL 后端没有 seek 钩子,即使只读尾部也要整解压 zstd 日志,慢路径仅在日志真实变化时运行。
  - 热刷新只读 header 中标题缓存未命中的会话;并发 `/list` 请求共享同一次列表重建。
- 全程复用 DSH 既有服务,**不解析会话文件内部格式**:
  - `ctx.workspaceRegistry` —— 归档状态与项目归属的权威来源;归档状态改写排入其自身操作队列,不与 DSH 原生归档操作交错。
  - `ctx.sessionController.inspect` —— 读取完整逻辑会话日志并折叠最后一条 `session/title` 事件(与 DSH 自身的"title"投影单元同逻辑;`sessionQuery.readTitleSnapshots` 对冷会话不可靠)。
- 可靠性(0.2.9+,0.2.11 增强):
  - 标题缓存与两个待删队列均为原子写(临时文件 + rename,权限 0600,与 DSH 自身存储一致),崩溃不会截断文件;待删队列截断意味着静默丢失排队删除。
  - 延迟删除清扫与 OpenViking 队列操作均走进程内单写者 promise 链,并发触发(20 秒定时、启动清扫、设置页快扫、手动删除入队)不会互相覆盖。
  - 取消归档会同步撤销该会话族排队中的删除;残留清扫仅清"不在归档集合且既不活跃也未持有工作区槽位"的会话目录,活会话不受影响(0.2.11)。
  - 删除因文件占用(如 Windows 锁)重试成功后,清扫会补齐全部收尾:OpenViking 联动、移除事件、rewind/review 快照与插件缓存清理(0.2.11)。
  - 待删队列加载时按会话 ID 形状校验条目,损坏的队列文件无法把任意字符串引入递归删除(0.2.11)。
  - AgentHandle 注册表改用 `WeakRef`,不会把已终结会话的整个对象图钉在内存里。
- 安全护栏:变更请求拒绝跨源 Origin(浏览器 fetch 总是携带 Origin;Desktop 管道的同应用请求不带 Origin,予以放行)并要求 JSON Content-Type;loopback 信任围栏由 webserver 桥 / Desktop 管道在上游施加。正在执行任务的会话立即返回排队回执,空闲但已挂起的会话在释放后立即删除。

- **自 0.2.10 开始** - 仅支持 DSH `0.1.5-rc.1 及之后版本`。标题读取先走 `sessionProjectionCache.cachedSnapshot(header)` 零 I/O 快路径,未命中则调用 `sessionController.inspect(id)`(不再回退 `sessionPersistence.inspect`);不依赖 `readFrom` 的事件序号/日志偏移参数,该参数已分型为独立的 `SessionLogOffset`。

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
dsh plugin --profile web add dsh-archived-conversation@0.2.11
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

所有路由挂载在共享 `/api` 通道,web 与 Desktop 同路径:

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/archived-conversation/ping` | 探活 |
| GET | `/api/archived-conversation/list` | 按项目分组的已归档对话列表(附带排队删除状态) |
| POST | `/api/archived-conversation/unarchive` | 取消归档,JSON body `{ "id": "<会话ID>" }` |
| POST | `/api/archived-conversation/delete` | 删除,JSON body `{ "id": "<会话ID>" }` |

变更接口拒绝跨源 Origin 请求并要求 JSON Content-Type;loopback 信任围栏由 webserver 桥 / Desktop 管道在上游施加。删除请求对正在执行任务的会话立即返回 `{ queued: true }` 回执;直接对子代理会话调用变更 API 会返回 HTTP 409,要求改由主对话统一管理。

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

本插件无需构建步骤。安装到 live profile 后,在浏览器打开 **设置 → 已归档** 即可验证(web 与 Desktop 均可);宿主 API 探活:`GET /api/archived-conversation/ping`。
