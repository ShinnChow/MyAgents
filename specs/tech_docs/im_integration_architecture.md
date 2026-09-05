# MyAgents IM 集成架构

> 本文定义 Agent Channel/IM 的 transport、Session 路由、Reply、交互与生命周期边界。OpenClaw loader、SDK shim 和 Bridge HTTP 协议的细节见 [`plugin_bridge_architecture.md`](plugin_bridge_architecture.md)；系统提示词与隐藏消息见 [`system_prompt_architecture.md`](system_prompt_architecture.md) 和 [`system_reminder_protocol.md`](system_reminder_protocol.md)。

## 1. 核心边界

IM 采用“Rust 持有连接，Node Runtime 持有 AI turn”的分层：

| 层 | Owner | 职责 |
|---|---|---|
| Channel transport | Rust `im/` | 平台连接、入站、出站、重连、白名单、群激活 |
| Plugin transport | 独立 Node Plugin Bridge | 加载 OpenClaw Channel Plugin，执行插件 reply renderer |
| Session routing | Rust `SessionRouter` + `SidecarManager` | peer→Product Session、Sidecar ensure/release、buffer |
| AI turn | Node Sidecar `SessionEngine` | Runtime admission、prompt、工具、transcript 与 terminal |
| UI | Renderer | 配置 intent、status 与交互投影；不拥有连接或 Session |

Transport 与 AI 生命周期彼此独立。Sidecar crash 时 Rust可以保留连接并缓冲新消息；Channel stop时必须释放其 Sidecar owner 和 Plugin Bridge资源，不能仅靠 config refresh。

当前产品模型是 Agent 拥有多个独立 Channel。legacy standalone IM Bot命令和存储只保留兼容读取/转发；新代码进入 Agent Channel lifecycle，不扩展旧模型。

## 2. Agent、Project 与 Channel desired state

`Project.agentId` 选择 AgentConfig，`Project.path` 提供 Project-backed工作目录。Agent不再以`workspacePath`作为主选择器；legacy path只在兼容修复或真 orphan中使用。

Channel 是否应运行由以下事实共同裁决：

```text
channel.enabled
&& setup / credentials ready
&& Project 未 archived
```

`agent.enabled`只门控Heartbeat、Memory Update和Memory Evo等主动能力，不控制Channel。关闭主动Agent不能隐式停止Channel；archive则在durable intent提交后显式收敛全部Channel与managed work。unarchive不改写`channel.enabled`，由标准auto-start/monitor重新恢复符合条件的Channel。

启动、停止、热配置、监控重启、proxy replacement和删除共用按`{agentId, channelId}`定位的lifecycle lock。取得锁后必须重读磁盘权威配置，避免旧snapshot启动或并发创建两个实例。

兼容迁移由Rust config owner在admission前、config lock内幂等执行。marker只表示迁移已提交，不得在后续读取时反复覆盖用户对Agent主动能力或Channel开关的修改。

## 3. Channel lifecycle

### 3.1 启动

标准启动顺序：

1. 取得Channel lifecycle lock并重读Agent/Project/Channel配置；
2. 校验workspace、credentials、platform capability与archive gate；
3. 创建health、buffer、SessionRouter和平台adapter；
4. 对OpenClaw Channel启动独立Plugin Bridge并完成liveness/readiness检查；
5. 发布运行实例后启动入站loop、event consumer、monitor与可选Heartbeat runner；
6. 只有当前generation仍是desired instance时才向Renderer投影Online。

启动中被stop/remove/archive抢占时，新实例不能发布；已创建的adapter、Bridge、consumer和Sidecar owner在同一lifecycle收敛。

### 3.2 停止与恢复

停止顺序为：关闭新admission，等待/终止Channel work，持久化可恢复的health/buffer/session binding，停止平台连接与Bridge，释放所有`Agent(sessionKey)` owners，最后从运行表移除exact generation。

应用启动与monitor只恢复desired且可运行的Channel。健康检查区分：

- process/loop liveness：决定是否replacement；
- gateway functional状态：只产生degraded/recovered诊断，不因短暂上游故障反复杀进程；
- AI Sidecar health：由SidecarManager自己的generation/recovery owner处理。

### 3.3 通用代理变化

Rust adapter与Plugin Bridge都属于general request proxy consumer。effective proxy变化时，在Channel model-work gate到达idle边界后复用标准stop/start，以磁盘配置重建transport。连续变化按generation合并到最终intent；不能另建proxy专用进程管理器或复制SessionRouter。

## 4. 入站消息与 SessionRouter

### 4.1 并发与 backpressure

每条消息先取得per-peer串行锁，再取得App级有界并发许可。router lock只覆盖短暂的binding/ensure/enqueue编排，不能跨AI执行或平台reply持有。

```text
platform / Plugin Bridge inbound
  -> authorize + group activation
  -> per-peer fence
  -> resolve Product Session binding
  -> ensure Session Sidecar + event consumer
  -> register requestId ReplySlot
  -> POST /api/im/enqueue
  -> SessionEngine Runtime admission
  -> /api/im/events
  -> ReplyRouter -> platform
```

Sidecar暂时不可用时，普通入站消息可以进入bounded durable buffer并在恢复后按peer顺序重放。OpenClaw `requestId/deliveryProtocol`不能写入durable buffer：原Bridge dispatcher只存在于当前进程，无法enqueue时必须立即terminal，不能让已丢失owner的协议请求在重启后重放。

### 4.2 Session key 与 owner

private和group使用不同、稳定的peer session key。每个binding记录Product Session id、workspace和当前Sidecar信息；Sidecar真正的存活权由`SidecarOwner::Agent(sessionKey)`表达。

IM与Desktop可以共享同一个Product Session，但owner保持独立。Tab关闭只释放Tab，Channel轮换只释放目标Agent owner；两边都不能reset或迁移对方的owner。

`/new`在per-peer fence内处理：

- 先按exact Product Session id查询SessionStore；
- 仅metadata仍存在的source需要freeze；stale/pending binding直接轮换；
- 发布一个metadata-birth-pending的新binding并释放旧Agent owner；
- 命令本身不创建空Sidecar、Runtime history或transcript；
- 首条普通消息通过标准ensure/materialization实体化；
- 任一失败恢复旧binding和group history。

desktop handover、heartbeat和surface migration复用同一per-peer fence，不能并发决定同一个binding。

### 4.3 Runtime identity drift

IM/Agent Channel是live-follow配置owner，但peer Session仍绑定完整执行identity`runtime + runtimeSource`。每次普通消息、heartbeat或模型切换唤醒前比较desired/persisted/live identity；发生真正漂移时轮换Session并释放旧Sidecar。

Managed Codex与system Codex即使Runtime type相同也不能复用。只切换同一identity中的model不等于Runtime漂移，配置由SessionEngine source-aware policy在turn boundary应用。

## 5. ReplyRouter 与渠道投递

### 5.1 request-scoped reply

`/api/im/events`按单调sequence提供可重连event stream。`ImEventConsumer`拥有`since=<lastSeq>`重连；`ReplyRouter`拥有`requestId -> ReplySlot`。

Native adapter：

- `partial`创建/编辑draft并执行节流和平台长度限制；
- `block-end`定稿当前text block；
- terminal收尾消息、清理pending interaction和slot。

OpenClaw reply：

- `deliveryProtocol:'openclaw-reply'`只表示本次request已经注册真实dispatcher；
- partial传当前raw text block的full snapshot；
- block-end只是顺序屏障；
- complete/error/cancelled透传producer-owned terminal；
-插件拥有CardKit/streaming/static fallback和最终平台delivery，Rust只做有序transport。

每个已注册request必须且只能有一个terminal。命令、白名单拒绝、群激活拒绝等早退也要以空complete或带原因abort结算，不能让dispatcher悬空。

### 5.2 Session binding delivery

ReplySlot只服务产生它的Channel user request。一个request结束后，Desktop、Session Inbox或后台触发的新turn不能复用旧slot。

跨surface投递通过`TurnChannelDelivery`显式选择owner：

| Turn来源 | user方向 | assistant方向 |
|---|---|---|
| Desktop | Session binding | Session binding |
| IM user request | none | ReplyRouter |
| Session Inbox / 普通后台消息 | none | Session binding |
| Heartbeat / Task relay / Agent Channel Goal | none | caller-owned |
| Memory或明确静默turn | none | none |

builtin/external各自在真实turn owner中capture完整text block，成功terminal且transcript持久化后才交给`im-mirror.ts`transport。失败、停止、被重试撤回、空文本、thinking/tool/subagent和`NO_REPLY`不投递。`SessionOrigin`与`InteractionScenario`只描述归因/prompt，不能推导delivery owner。

## 6. 权限与结构化提问

### 6.1 Permission request

非自动授权模式下，Runtime permission request经IM event bus交给ReplyRouter。pending按request id保存Sidecar、chat、platform message与过期时间；用户通过原生卡片/按钮或受限文本fallback响应，Rust再POST到Sidecar permission endpoint。

只有Runtime确认响应被接纳后才能删除pending和更新UI。stop、reset、terminal或expiry必须精确使对应request失效。多个pending不能用单槽位覆盖。

### 6.2 Host interaction capability

`hostInteraction.askUserQuestion`描述当前Channel host能否承接Runtime的同步结构化提问：

| 值 | 语义 |
|---|---|
| `none` | 禁用/取消同步AskUserQuestion，避免Runtime无限等待 |
| `native-card` | 通过event bus与平台交互卡片完成同一个pending request |

默认是`none`。原生飞书adapter可以声明`native-card`；Telegram、Dingtalk和OpenClaw Bridge不能因为插件有“异步卡片工具”就冒充同步host能力。

敏感问题在IM中fail closed：不能要求用户把secret作为普通聊天文本或fallback答案发送。问题响应只有Sidecar返回成功后才清理pending；同chat多题/多pending的fallback路由必须确定且记录歧义诊断。

## 7. 群聊

### 7.1 激活

| 模式 | 语义 |
|---|---|
| `Mention` | 只有明确@bot或`/ask`触发；其它消息进入bounded group history |
| `Always` | 每条消息触发；模型可用`NO_REPLY`保持静默 |

群消息默认`isMention=false`，除非native adapter或Plugin明确提供证据。平台若只在@bot时才把事件下发，UI与runtime都必须把`Always`标为不可表达，不能伪装支持。

### 7.2 Prompt context

Rust拥有group activation、pending history和group metadata；Sidecar在`/api/im/enqueue`边界组装最终prompt。上下文按当前字段提供group名称、平台、sender、引用、用户配置的group instruction和未触发history。动态文本进入结构化标签前必须escape/bound；Renderer或Bridge不拼另一份群聊system prompt。

群名称按“用户配置 → platform/plugin hint → chat id”解析。`groupToolsDeny`只是额外可选禁用层，不替代权限模式、MCP选择或工具自己的安全检查。

## 8. OpenClaw Plugin Bridge

OpenClaw Channel通过独立Node进程适配，不把第三方插件加载进Rust或AI Sidecar。Rust `BridgeAdapter`拥有进程、health、sender registry和HTTP transport；Bridge拥有plugin import、OpenClaw compat runtime与平台reply dispatcher。

### 8.1 身份与生命周期

安装ID/npm包名/协议Channel ID是不同事实。Rust按安装ID定位目录；Bridge按manifest/registerChannel得到协议ID并构造`cfg.channels.<channelId>`。启动时敏感配置通过environment传递，runtime state按MyAgents Channel隔离，不能回落到共享`~/.openclaw`。

安装、loader、shim、health endpoint与process-tree规则只在 [`plugin_bridge_architecture.md`](plugin_bridge_architecture.md) 维护，本文不复制。

### 8.2 MCP tool surface 与 turn context

Plugin tool schema是Session-level surface；sender/chat/account/owner是request-level identity：

- stable surface identity由Bridge port、plugin和enabled tool groups规范化；
-同一generation只发现一次schema并复用settled result；identity变化才创建新generation；
- discovery/readiness共享builtin MCP soft grace；live map mutation仍是独立turn-boundary correctness fence；
- `ImBridgeTurnContext`只在exact request registry中存在，tool callback通过output-owner FIFO解析当前request；
- request context在runtime terminal后立即不可读，不能被相邻realtime消息覆盖；
- tool执行budget从真实`/mcp/call-tool`开始，不和surface discovery budget混算。

request registry的清理权在admission route与runtime之间明确移交：admission前失败由route清理；接纳后由runtime terminal清理；cancel只有在成功移除queued item时接管。任何request都不能有两个terminal emitter。

## 9. Heartbeat、Task 与 Goal

### 9.1 private target

Agent可以有多个Channel，后台结果不能广播到全部Channel。`lastActivePrivateTarget {channelId, sessionKey}`是Heartbeat、Task completion和manual wake的目标authority，只由private user ingress/handover更新；group activity不能覆盖。

解析规则：

1. 有exact private target时只验证该目标；失效则跳过，不fallback；
2. 没有target时，可从仍在线且明确为private的legacy last-active记录一次性seed；
3. 只有完全没有历史时，才在online Channels中选择最近private session；
4. wake必须携带exact target，per-Channel runner不得再次猜测。

pending Task/Cron delivery持久化target session key，并由同一Channel queue按序ACK。没有valid private target时只保留领域执行历史，不把事件塞入任意旧Bot queue。

### 9.2 Goal

在IM/Agent Channel当前Session创建的Goal仍属于该Product Session：

- 通过统一Goal facade创建，不创建Task/Cron；
- continuation经SessionEngine恢复原interaction scenario；
- Runtime promotion时claim，terminal后由Goal owner finalize；
- 只有`agent-channel` continuation把成功文本写入Goal delivery outbox；
- outbox按stable delivery id at-least-once投递，缺binding不ACK；
- `NO_REPLY`保持静默。

detached/new-session Goal需要独立parent/return-target设计，不能混入current-session Goal。

## 10. 配置与持久化

`config.json`是Agent/Channel desired config authority。所有写入在config lock内fresh read-modify-write；Renderer提交typed intent并在成功后refresh完整snapshot，不能用可能过期的React state覆盖其它Channel。

运行时文件只保存可重建projection，例如health、bounded buffer、dedup与peer binding；它们不能覆盖config或SessionStore。health的uptime snapshot不是实时计时authority，live status由当前instance generation/started-at计算。

Channel credential、token、App Secret和provider env不得进入日志、analytics、Tauri event或错误正文。配置持久化方式的现实限制应由credential owner和安全设计统一解决，本文不维护“以后迁移”计划。

## 11. 安全不变量

- 空白名单默认拒绝，不等于allow all；QR bind只绕过对应的一次绑定admission。
- group默认Mention，未证明mention的事件不能触发AI。
- Channel默认权限由当前Runtime的unattended policy解析；不继承桌面Agent permission造成静默降权。用户显式override才改变。
- credentials、prompt正文、tool参数、群history和platform payload不写常规日志。
- platform/network request使用统一proxy、timeout、rate-limit与retry policy；401/invalid credential停止或降级，不无限重试。
- QR credential provisioning只由Rust访问HTTPS allowlist并归一化response；Renderer只持短期session handle和展示数据。
- Plugin Bridge是受管`ChildTree`；停止/卸载不能按进程名扫描或递归删除未验证目录。
- Session、workspace和attachment路径经过既有canonical validation；Channel不能扩大Runtime文件权限。

## 12. 关键实现

| 路径 | 职责 |
|---|---|
| `src-tauri/src/im/agent_channel.rs` | Channel lifecycle与入站编排 |
| `src-tauri/src/im/router.rs` | peer→Session binding与Sidecar owner |
| `src-tauri/src/im/enqueue.rs` | Rust→Node admission |
| `src-tauri/src/im/event_consumer.rs` | `/api/im/events` reconnect与dispatch |
| `src-tauri/src/im/reply_router.rs` | request-scoped reply与interaction |
| `src-tauri/src/im/{telegram,feishu,dingtalk}.rs` | native adapters |
| `src-tauri/src/im/bridge.rs` | Plugin Bridge process/transport owner |
| `src-tauri/src/im/{buffer,group_history,handover}.rs` | buffer、group context与surface handover |
| `src-tauri/src/im/{health,heartbeat,runtime_change}.rs` | health、private wake与Runtime drift |
| `src-tauri/src/memory_auto_update.rs` | Memory Update managed task/config owner |
| `src/server/session-engine/` | Runtime-neutral IM admission与turn result |
| `src/server/tools/im-bridge-tools.ts` | Bridge MCP surface与request context |
| `src/server/utils/im-mirror.ts` | Session binding delivery transport |
| `src/renderer/components/AgentSettings/channels/` | Channel配置intent与status UI |

Product Session owner、删除、恢复与配置snapshot详见 [`session_architecture.md`](session_architecture.md)。
