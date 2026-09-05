# Session 架构

> 本文定义 Product Session 的身份、Owner、持久化、Runtime 绑定、恢复与配置裁决。字段、端点和事件清单以代码与类型为准；Sidecar 进程拓扑见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md)。

## 1. 权威边界

Session 不是单一对象，而是同一产品会话在不同生命周期阶段的几种事实：

| 事实 | Authority | 说明 |
|---|---|---|
| Product Session identity 与 metadata | `SessionStore` | 稳定 `sessionId`、workspace、标题、Runtime 类型、配置快照等 |
| 当前 Product Session 绑定 | `session-engine/product-session-binding.ts` | 当前 Sidecar 正在服务哪个 Product Session |
| Runtime execution identity | 对应 SessionEngine adapter | builtin 的 SDK Session UUID；外部 Runtime 的 thread/session id |
| Sidecar 生命周期与 Owner | Rust `SidecarManager` | 创建、复用、replacement、Owner 附着与释放 |
| transcript | `SessionStore` | MyAgents UI、搜索与恢复使用的产品历史 |
| 当前 turn 与 Runtime queue | 对应 adapter | admission、执行、stop 与 terminal settlement |
| Goal 状态 | Rust `SessionGoalManager` | 独立于 Session metadata 与 Task 的 durable state |
| Renderer 投影 | `TabProvider` / `useTabState()` | 只投影当前 Tab 所属 Session，不反向成为业务 authority |

后产生的数据不自动获得上游写权限。例如，Runtime 返回的 SDK UUID 只能更新 execution identity，不能替换 Product Session id；IM 的实时配置不能覆盖已有 Session 的 owned snapshot。

## 2. Product Session 与 Runtime identity

每个 Product Session 有稳定的 `SessionMetadata.id`。它拥有历史、Tab/Sidecar scope、workspace、配置快照和产品级状态。Runtime 还可以拥有独立执行身份：

- builtin 使用 `sdkSessionId` 作为 Claude Agent SDK 的 create/resume candidate；
- Codex、Claude Code、Gemini 等外部 Runtime 使用 `runtimeSessionId`；
- Rewind、Fork 或 provider history 边界可以替换执行身份，但不得偷偷替换 Product Session identity。

普通新会话中两个身份可能相同，这只是初始化结果，不是可依赖的不变量。读取和写入 metadata 时使用 `src/server/types/session.ts` 的当前类型，不在文档中复制完整字段表。

### 2.1 新建、恢复与 SDK probe

builtin 启动先解析持久化的 SDK candidate，再确认对应 SDK transcript 是否存在：

1. probe 成功且 transcript 存在时，以 `resume` 恢复；
2. probe 成功但 transcript 不存在时，以同一个 candidate fresh create；
3. probe 出错时拒绝启动，不回退到 Product Session id 或随机新身份。

SDK 的 `sessionId` 与 `resume` 互斥。`resumeSessionAt` 只是在已选定的 SDK history 中指定 Rewind 锚点，不证明该历史存在；锚点失效时可清除锚点并降级为普通 resume，但不能改变 Product Session identity。

### 2.2 pending materialization

`pending-{tabId}` 是尚未实体化的新 Tab identity。首个被 Runtime 接纳的 turn 才把它迁移为真实 Product Session。

迁移由 `SessionStore` 在 source/target transcript 锁与 sessions index 锁内线性化：metadata 发布、已有 transcript 的重命名以及失败回滚必须表现为一次 identity 迁移，不能产生两个可继续分叉的会话。

backend-created draft 使用 `materializationState: 'prepared'` 隐藏尚未被 Runtime 接纳的 metadata。turn admission 与 rollback 通过同一存储层 CAS 竞争；admission 赢后发布 Session，rollback 赢后该 turn 必须在发布 accepted 之前失败。

### 2.3 删除

用户删除的 lifecycle authority 是 Rust `cmd_delete_session_if_unowned`，不是 Renderer 或裸 HTTP storage delete。删除必须在 per-Session lifecycle fence 内同时确认：

- 没有 Task、Goal、IM binding 或其它非 Tab owner；
- active/recovering Sidecar 没有未授权 owner；
- Runtime 已明确 idle，或正在运行的 turn 已安全移交给 `BackgroundCompletion`；
- Node storage mutation 成功或幂等 not-found。

只有满足这些条件后，Rust 才释放调用方提交且已验证的 Tab owner。失败时保留 Session 与 Tab，不能用 Renderer 的 `isGenerating`、事前端口探测或列表缓存代替最终裁决。

## 3. Session metadata 的语义

### 3.1 配置快照

`configSnapshotAt` 存在表示 Session 拥有自己的执行配置快照。此后缺失字段代表产品默认或未固定，不能重新回落到 Agent/Project 当前值。Agent/Project 配置只用于：

- 新 Session 模板；
- 尚未建立 snapshot 的兼容会话；
- 无 Tab owner、明确 live-follow 的 IM 场景。

`providerRoute` 是 builtin provider/model 的 canonical identity，只持久化 provider 类型、provider id 与 model。API key、base URL、auth mode 和 aliases 始终从当前 `config.json` materialize，不能写入 Session 历史。`providerEnvJson` 只作为旧 Session 的只读兼容输入；新的 snapshot 写入必须使用 `providerRoute` 并移除 legacy env。

MCP 也是分层 authority：Session snapshot 冻结 server ID 选择，当前 `config.json` 拥有 server definition 与全局 enabled 安全总闸。执行前的有效集合为：

```text
session selected IDs
∩ globally enabled IDs
∩ current server definitions
```

同 ID definition 变化需要更新 Runtime MCP surface；Project 默认变化不能改写已有 Session 的选择。

### 3.2 活跃时间、置顶与 Tag

`lastActiveAt` 是 meaningful Session activity 的排序时间，不等于最后一条真人消息时间，也不随任意 JSONL 写入变化。被 turn lifecycle 接纳的可见工作在 admission 和 terminal 更新；pre-warm、replay、silent heartbeat、Memory maintenance 与纯历史重写不更新。需要真人输入时间的调用方应读取消息时间戳。

`pinnedAt` 只表示 Workspace Session 列表中的置顶顺序。置顶与 Tag 都是整理动作，不推进 `lastActiveAt`。Tag assignment 绑定 Product Session id；pending materialization 保留，Reset 与 Fork 不继承。所有 Tag mutation 由 `SessionStore` 在 sessions index 锁内以 typed intent 更新，Renderer 不提交 replacement array，也不维护第二份 Tag catalog。

## 4. Runtime 与 turn 生命周期

### 4.1 统一 facade

所有 Session 操作经 `src/server/session-engine/` 选择 adapter。Route handler 不自行判断 builtin/external，也不借用另一 Runtime 的 reset、Session 创建或 identity 逻辑。

Product Session 的 prepare/commit/rollback 由 `product-session-binding.ts` 管理。只有 adapter 完成自己的 Runtime 清理和准备后，新的 binding 才能发布。Global Sidecar 可以加载公共类型和工具，但不能创建 Product Session 或通过 Chat、IM、Inbox 间接建立当前 binding。

### 4.2 builtin

`src/server/agent-session.ts` 是 builtin 的 public facade。可变状态按 owner 分布在 `src/server/builtin-session/`：

| Owner | 职责 |
|---|---|
| `lifecycle.ts` | SDK `Query`、pre-warm、abort、generation 与 Query-scoped resources |
| `queue.ts` | desktop realtime/turn-boundary queue、in-flight item 与 admission ticket |
| `turn.ts` / `turn-lifecycle.ts` | 当前 turn 状态与 complete/stopped/error settlement |
| `config.ts` | model、permission、reasoning、provider、MCP 与 deferred restart |
| `transcript.ts` / `transcript-persistence.ts` | live transcript、cursor、SDK UUID tracking 与 durable mutations |

`session-core/` 只放 pure policy。`session-engine/` 与 routes 只调用 public facade，不直接 import builtin owners。`abortPersistentSession()` 是语义化 abort 入口；terminal 成功必须由真实 SDK result policy 判定，不能把 idle 或未知 reason 当成功。

每次 SDK Query launch 都有只属于该 Query object 的 identity authority。`system_init` 只有在 authority 未撤销、Product binding 未改变且 SDK Session id 与启动期望相同时，才可更新 metadata。旧 Query、旧 generation 或未知 identity 的迟到事件一律丢弃。

desktop 连续发送支持 realtime 与 turn-boundary 两种策略，但两者仍共享同一个 Runtime queue owner。Stop 中止当前 turn，不凭空取消 SDK 已接纳但尚未消费的项；queue receipt、replay 或 assistant-start 才能确认后续项的真实状态。

SDK background Agent/Bash 与父 turn 共用同一个 Query 和 Sidecar。自动 deferred restart 必须等待该 Query 的 background-task registry 清空；显式 Stop、Reset、Session switch、应用退出和真实 Query crash 仍可终止。

MCP pre-warm 是 soft readiness observation，不是 AI turn 的 admission authority。未 connected、读取失败或观察超时不能拒绝业务 turn；真正的 MCP surface replacement 则是 Query-generation correctness fence，必须在 turn boundary 串行应用。

### 4.3 external Runtime

外部 Runtime 的当前 session、process/transport、operation queue、config state、transcript cursor 与 terminal result 分别由 `src/server/runtimes/external-session/` 下的 owners 管理，对外通过 `external-session.ts` facade 暴露。

配置变更和 message 使用同一 operation queue：当前 turn 继续使用 admission 时的 snapshot，前导 config operation 在下一个 turn boundary 应用。RPC/stdio write 开始后发生 transport error 只表示 acknowledgement 不确定，不能证明 prompt 未被执行；Stop 必须按精确 queue id 等待 startup/transport/termination settlement。

外部 Runtime 的“进程 idle”不等于 turn 成功。Task、Goal、通知和 UI terminal 都必须读取 adapter 提供的真实 result classification。

### 4.4 Rewind、Fork 与 reload anchor

Rewind 是 transcript 与 Runtime history 的联合 mutation：

- Product Session identity 保持不变；
- builtin 更新 SDK execution identity/anchor，并用命名的 transcript mutation 截断 MyAgents history；
- Codex 使用已持久化的 root-turn anchor 与 thread identity 恢复可继续的历史；
- 冷加载时的 `reloadAnchor` 只用于把 UI 恢复边界与 Runtime history 对齐，不成为新的 Session identity。

Fork 创建新的 Product Session，因此不继承 source 的 Agent origin、Goal、置顶或 Tag。Runtime-specific history clone/fork 由对应 adapter 负责。

## 5. Goal 与跨 Session 协作

### 5.1 Goal

Goal 是 current Session 的独立 durable state，存储在 `session_goals.json`，不嵌入 Session metadata，也不复用 Task/Cron。`SessionGoalManager` 是唯一业务 owner，同一 Session 最多一个 unfinished Goal。

Goal 只拥有 objective、状态、end conditions、permission policy、当前 turn fence、统计与 delivery outbox；Runtime/model/provider/MCP 仍由 Session 拥有。Goal turn 通过现有 SessionEngine queue 执行，不建立第二套 queue 或 outcome cache。

turn 在 adapter 的真实 promotion boundary claim，以 `goalId + queueId + sidecarGeneration` 拒绝旧 incarnation、旧 queue 与旧进程的迟到回写。Pause、Cancel 和 terminal 先 durable commit，再精确 stop owned turn；termination 未确认时保留 queue binding、Goal owner 与恢复信息。Tab 关闭只释放 Tab owner，不能停止 Goal。

自动 continuation 是 one-shot 调度，只在上一 turn settlement 后安排。deadline、execution limit、用户控制与模型 terminal 都由 `SessionGoalManager` 在线性化边界内裁决；模型只能请求允许的 terminal，不能仅靠 prompt 绕过 `aiCanExit`。

Goal 的详细产品行为和 Task/Goal provider routing 见 [`task_center.md`](task_center.md) 与 [`task_provider_routing.md`](task_provider_routing.md)。

### 5.2 Session Inbox 与事件

`myagents session start/send/watch` 使用结构化 session event，不是普通文本拼接。事件经 Admin/Management API 投递到目标 Session 的既有 Inbox/SessionEngine admission，并放在隐藏的 `system-reminder` envelope 中；来自其它 Session 的正文必须 neutralize 协议标签。

- `send.request` 投递工作；Renderer 只把它的可见 payload 投影为用户气泡；
- `send.result` 在目标 turn terminal 后回传结果；
- `watch` 根据注册时的真实 activity 返回 already-idle、completed 或 error；未确认投递成功前不能清理 pending watch；
- Task Comment 复用同一 Inbox 与 Session FIFO，但通过 task-specific event 和显式回复命令回写 Task，不自动复制普通 assistant 输出。

backend-created target 只有在 Runtime dispatch claim 成功后才发布 prepared Session；ACK 不明时保留 identity，不能自动重试导致重复执行。

### 5.3 Registered Agent origin

Space Issue Delivery 复用 Inbox admission，但使用专用 `myagents-space-issue` reminder 与持久化 origin。Registered Agent identity 必须同时绑定 exact `spaceId` 与 `registeredAgentId`；缺失、畸形或普通 desktop origin 都 fail closed，不能因 workspace 相同或一次定向 delivery 把普通 Session 提升为 Agent。Fork 总是重置为 desktop origin。

完整协议见 [`space_issue_delivery_protocol.md`](space_issue_delivery_protocol.md) 与 [`system_reminder_protocol.md`](system_reminder_protocol.md)。

## 6. 持久化与恢复

### 6.1 MyAgents transcript

`SessionStore` 使用 `~/.myagents/sessions.json` 保存 metadata index，并在 `~/.myagents/sessions/` 下按 Session 保存 JSONL transcript。JSONL 支持 append、流式增量持久化、tail cursor 与损坏行隔离；路径必须先经过 canonical Session id validation，不能把用户输入直接拼进文件路径。

普通写入只追加尚未落盘的 tail。Rewind、retraction、reset、migration 和 delete 使用命名 mutation，在对应文件锁与 index 锁内执行；调用方不得自行改写文件。

### 6.2 MyAgents 与 SDK 双重存储

两份历史服务不同 authority：

| 存储 | 用途 |
|---|---|
| MyAgents JSONL | UI 展示、搜索、Session 列表、跨 Runtime 的产品历史 |
| Runtime 原生存储 | SDK/CLI resume、上下文连续性、Runtime 自有 cache 与 branch 语义 |

不能用其中一份替代另一份。产品层恢复以 MyAgents transcript 为准，执行层 resume 以 adapter 的 native identity/history 为准；两者通过显式 identity 和 rewind boundary 对齐。

### 6.3 REST snapshot 与 SSE

Rust 按 `(sidecar key, generation)` 把控制请求和 SSE 代理到当前进程。每次实际 replacement 都产生新 generation；旧 generation 的 response、terminal、activity 和 notification claim 必须丢弃。

REST 是冷启动和重连后的 Session snapshot authority，SSE 只提供 snapshot 之后的增量事件。前端先读取历史与当前状态，再按 revision 接收 live event；不能把断线期间缺失的 SSE 当成历史不存在。

SSE transport 断开不代表用户取消，也不拥有 abort 权限。turn 继续执行并持久化；只有显式 Stop、Session lifecycle 命令、Runtime terminal 或 Sidecar termination 能改变执行状态。

会改变当前 Session snapshot、队列边界或阻塞式交互 UI 的事件必须携带 `sessionId`，并通过 `sessionScopedEventGuards.ts` 与当前 Tab identity 比较。pending→real 等已被 lifecycle authority 确认的 identity upgrade 可以沿用 transport；普通 real→real 历史导航必须 new/jump/revive 到目标 Tab，不能把旧连接标签当业务 authority。

Renderer 的 activity state 由 `TabProvider` 对当前 Session 的 REST snapshot 与合法 SSE terminal 投影。所有 complete/stopped/error、reset、connection replacement 和 unmount 路径都必须收敛 activity 与 pending UI；不要通过增加另一个 `isGenerating` truth source 修补遗漏。

### 6.4 完成通知

普通 Session 的系统完成通知由 Rust `notification.rs` 统一裁决。Tab SSE proxy 与无 Tab 的 `BackgroundCompletion` 只能向当前 Sidecar generation 申请一次性资格，再由通知 owner 判断 origin、窗口焦点、偏好、badge 与 deep-link。

Task、Goal、Agent Channel、Memory、Heartbeat 等领域使用自己的通知/投递语义。transport 断线期间的 turn 仍可恢复历史，但普通通知没有 durable outbox，不能承诺断线窗口补发。

## 7. 配置写入方向

### 7.1 `sidecarConfigDisposition`

Chat mount 必须明确当前 Tab 对 Sidecar 配置的方向：

| 状态 | 语义 |
|---|---|
| `push` | Sidecar 是本次新建，Tab 将自己的 Session 配置推入 |
| `adopt` | Sidecar 已由 IM、Task、Goal 或 background 使用，Tab 采纳现有配置 |
| `pending` | ensure 尚未裁决；既不 push 也不 adopt |

`pending → push|adopt` 的唯一依据是 Rust manager 锁内 `ensureSessionSidecar().isNew`。端口探测、Renderer 缓存和事前 `hasSidecar` 都有 TOCTOU，不能决定配置方向。

mount 期配置同步必须受 disposition 门控；用户主动修改配置可以先持久化 intent，但在 `pending` 期间延后 Runtime push。打开已有 Session 的所有入口都复用 App 的 materialization/reconcile 流程，以 exact Tab owner ensure 并在 replacement 时保持 Owner 集合。

### 7.2 snapshot setter guard

`sidecarConfigDisposition` 约束 desktop writer；Runtime config policy 还必须约束 IM 等其它 writer。已有 `configSnapshotAt` 的 Session 保持 snapshot authority：

- desktop 用户主动修改先写 Session snapshot，再经 desktop source 应用；
- IM warm/sync 不覆盖 owned model/provider/permission/reasoning；
- IM 每轮需要的 channel 配置通过 send context 在 admission 时解析；
- external Runtime 先执行 source-aware filtering，再把合法配置 operation 加入 turn-boundary queue；
- Task 配置只初始化新的 Task Session，已有 Session 继续使用自己的 snapshot。

纯 policy 位于 `session-core/runtime-config-policy.ts`。新增 setter 或调用方时必须显式标注 source，并在写 desired/live state 之前完成过滤，不能先污染状态再跳过 restart。

## 8. 关键实现

| 路径 | 职责 |
|---|---|
| `src/server/types/session.ts` | 当前 Session metadata 与消息类型 |
| `src/server/SessionStore.ts` | metadata、JSONL、migration 与 typed mutations |
| `src/server/session-engine/` | Product binding、Runtime selector 与统一 adapter contract |
| `src/server/agent-session.ts` | builtin public facade |
| `src/server/builtin-session/` | builtin lifecycle、queue、turn、config 与 transcript owners |
| `src/server/runtimes/external-session.ts` | external public facade |
| `src/server/runtimes/external-session/` | external process、queue、config、transcript 与 result owners |
| `src-tauri/src/sidecar/` | Session Sidecar、generation、Owner 与 recovery |
| `src-tauri/src/session_goal/` | Goal durable owner |
| `src/renderer/types/tab.ts` | `sidecarConfigDisposition` |
| `src/renderer/App.tsx` | Session Tab create/open/revive 与 owner reconciliation |
| `src/renderer/context/TabProvider.tsx` | 当前 Tab 的历史、SSE 与 activity 投影 |

相关边界：

- Runtime adapter：[`multi_agent_runtime.md`](multi_agent_runtime.md)
- Task / Goal：[`task_center.md`](task_center.md)、[`task_provider_routing.md`](task_provider_routing.md)
- Prompt envelope：[`system_reminder_protocol.md`](system_reminder_protocol.md)
- 可执行护栏：[`pit_of_success.md`](pit_of_success.md)
