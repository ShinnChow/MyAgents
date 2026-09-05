# MyAgents Cloud Space 架构

> 本文只描述 Desktop 侧的 Cloud Space owner、身份、Connector、Session 注入与安全边界。Cloud API、D1/R2/KV、配额与运营逻辑以平级仓库 `../MyAgents_space/specs/ARCHITECTURE.md` 为准；逐字 IssueDelivery prompt 见 [`space_issue_delivery_protocol.md`](space_issue_delivery_protocol.md)。

## 1. 定位与权威边界

Cloud Space 是 Desktop 连接团队服务的实验性能力，不是 AI Runtime，也不属于 Session Sidecar。

| 事实 | Authority |
|---|---|
| Cloud 用户、Space、Issue、Goal、Skill、Tool、Registered Agent、Delivery、plan/quota | MyAgents Space Cloud API |
| build capability 与 service origin | Rust build/runtime capability |
| 用户 credential 与 redacted account cache | Rust `space_cloud` root facade |
| 本地 device id | `src-tauri/src/device_identity.rs` |
| 本地 Registered Agent mapping/token | Rust `space_cloud::registered_agents` |
| Delivery polling、presence 与 Session 注入 | Rust `space_cloud::delivery` |
| UI cache 与导航 | Renderer `spaceStore` / Space pages |
| AI automation surface | `myagents space ...` CLI，经 Sidecar Admin API 与 Rust Management API |

Renderer 不持有 session/agent token，不直接访问 Cloud Worker。跨两个仓库的契约变化必须同步更新 Cloud serializer/tests 与 Desktop types/wrapper/tests；部署状态只以对应环境的健康端点和发布系统为准，不写进本文。

## 2. 构建与运行门控

Space 是 build-time capability：

- `src-tauri/build.rs` 只转发 `MYAGENTS_SPACE_*` 白名单；
- production origin 必须是无 credential、无 path/query/fragment 的 HTTPS origin；
- release build 不携带 Dev origin；
- `cmd_space_get_capability` 返回 Rust 当前可用的 baked origin，Renderer 还要叠加 `config.teamSpaceEnabled`；
- `config.spaceEnvironment` 只能在构建中已经烘焙的 production/dev origin 间选择；
- 所有请求通过 `space_build_capability()` / `space_base_url()` 解析 origin，不能硬编码或让用户输入任意 URL。

debug/test 可以通过 `MYAGENTS_SPACE_MOCK_DATA=true` 使用 Rust owner 的 deterministic mock。mock 不读取真实 Space session、不访问生产服务，也不能在 Renderer 建第二套假数据路径。

## 3. Desktop 模块边界

| 层 | 路径 | 职责 |
|---|---|---|
| Rust facade | `src-tauri/src/space_cloud.rs` | build capability、account credential、HTTP/client context、session cache与跨领域编排 |
| Registered Agent | `src-tauri/src/space_cloud/registered_agents.rs` | Agent binding、token、instruction/subscription projection |
| Delivery | `src-tauri/src/space_cloud/delivery.rs` | Connector、poll/presence、receipt/ACK 与 Session injection |
| CLI | `src-tauri/src/space_cloud/cli.rs` | actor/context 解析与命令适配 |
| Attachments | `src-tauri/src/space_cloud/attachments.rs` | bounded upload/download 与 workspace file safety |
| Skills / Tools | `src-tauri/src/space_cloud/{skills,tools}.rs` | package/install 与 Tool transport |
| Notifications | `src-tauri/src/space_cloud/notifications.rs` | App 级 Cloud feed 同步 |
| Renderer API | `src/renderer/api/spaceCloud.ts` | typed invoke 与错误投影 |
| Renderer state | `src/renderer/pages/space/spaceStore.ts` | UI cache、cursor invalidation 与导航投影 |

领域模块共同复用 root auth/client 和已有文件安全 helper。需要同时修改多个领域状态的 command由 root facade协调；子模块不能相互借用 token 或建立平行 HTTP client。

## 4. 身份模型

### 4.1 Device

Space 与 Analytics 共用 `~/.myagents/device_id`。`device_identity.rs` 在文件锁内读取/创建，避免并发启动生成两个 identity；Renderer只通过 typed invoke/cache 消费。

Cloud 的 `user_devices` 以 `(userId, deviceId)` 表示账号在某台设备上的记录。普通 `lastSeenAt` 是账号/设备活动，不能解释为 Connector 在线。在线状态由独立 presence lease产生，Renderer只展示服务端返回的 `online/offline` 与时间，不复制 lease 阈值自行计算。

### 4.2 Registered Agent

Registered Agent 是本地执行实例，不是 device，也不是 workspace 的别名。同一 user/device/Space/workspace 可以登记多个实例，每个实例有独立 id、token、Instruction、Subscription 与 Session binding。

本地绑定包含 stable `localWorkspaceId`、`localAgentId` 以及展示用 path/label。只有同时满足 owner user 与当前 device id 的实例才是 local；不能通过 hostname、client id 或本地缓存命中推断。

`instruction + instructionRevision` 由 Cloud 以 revision CAS拥有。Subscription 只描述唤醒范围和 run mode，不复制 Instruction。Desktop编辑成功后使用 Cloud 返回的完整 authoritative subscription集合覆盖本地 projection，不能根据请求参数乐观拼接或删除 UI 未展示的规则。

Registered Agent token 是受限 capability：Cloud 从 token 派生 user、space、agent 和 device。Desktop不得在请求 body 中自报这些身份，也不能在 agent token 失败后回退为 user session。

### 4.3 User credential lifecycle

用户 credential 有三种持久语义：session 文件缺失表示 signed out，`Authenticated` 持有当前 token，`ReauthRequired` 只保留被失效的 `sessionBindingId` 且不得残留 token。旧顶层 `sessionToken` 只在读取边界迁移；下一次写入必须使用 canonical tagged state。

只有 **user session** 的 HTTP 401 可以触发 `Authenticated → ReauthRequired`；Registered Agent 401、403、429 和服务端错误不得清除用户登录。失效提交在 session 文件锁内比较发起请求时捕获的 exact `sessionBindingId`：旧账号/旧 token 的迟到 401 不能覆盖后来登录。refresh/login 写回同样只在磁盘 binding 仍等于启动时观察值时提交，因此 logout、reauth 或 account switch 之后返回的旧 refresh 不能复活 credential。

## 5. CLI actor 与凭据

Space CLI 不接受显式 token/actor：

- 普通 Session 没有 exact Registered Agent origin时，以当前 user session行动；
- 带 `{spaceId, registeredAgentId}` origin 的 Session只使用该实例的 token，并校验 owner、device、workspace 与 route Space；
- binding/scope 不匹配直接失败，不降级为 user actor；
- 本机恰好存在 Agent token不能把普通 CLI自动提升为 Registered Agent。

每个命令显式指定 Space slug；Sidecar从当前 Project补 stable workspace identity，Rust最终选择 actor和 credential。generic Issue update只修改明确定义的 metadata字段；state、assignee、claim、comment和attachment使用各自命令，避免一个宽泛 endpoint绕过领域权限。

## 6. IssueDelivery 与 Session 注入

Delivery 是“某个 Registered Agent 应看到一次 Issue 变化”的 transport事实，不是 assignee、claim 或执行完成状态。

```text
Cloud pending delivery
  -> Rust Connector poll
  -> validate protocol + exact Agent context
  -> resolve/create Product Session
  -> SessionEngine Inbox admission
  -> local receipt
  -> Cloud ACK
```

处理不变量：

1. Connector按当前 origin/account/device 下的 runnable local Agents运行，不依赖 Space页面是否打开。
2. poll使用 Registered Agent token；Cloud返回 Delivery package与下一次 poll建议，Rust只负责 clamp、jitter、错误退避和执行。
3. package必须携带 exact `spaceId + registeredAgentId`、Instruction revision和合法 Issue元数据。未知 protocol/kind/reason/status fail closed并保留 pending。
4. Rust按照 run mode选择或创建 Session，并持久化 exact Registered Agent origin；不能复用同 workspace 的普通 Session或其它 Agent。
5. 注入经既有 SessionEngine Inbox admission，专用 prompt envelope在本地组装；Cloud不下发完整 system prompt。
6. Runtime接纳后先写本地 receipt，再ACK Cloud。ACK只结算自己的 transport row，不代表 claim、处理或完成。
7. AI后续通过 `myagents space issue ...` 读取和修改 Issue；不行动是合法业务决策，不需要“ignore Delivery” mutation。

Delivery mode：

| Mode | 语义 |
|---|---|
| `subscription` | 未指派 Issue命中 Goal/state订阅后的发现通知 |
| `assignment` | 人工指派给某一 Registered Agent 的定向通知 |
| `claim_followup` | 已 claim 工作在其它身份更新后回到 exact claim Session |

subscription不授予责任，assignment不与订阅混批，follow-up不能丢失其 Session hint后随意投到另一个会话。assignee、claim与Delivery是三份不同事实。

### 6.1 Connector presence

Delivery GET 是纯读，不顺带更新 device online。Connector在至少一次成功 poll 后，以稳定 token调用独立 presence endpoint；同一 `(origin, owner, device)` 有多个 Agent也只维护一份 device presence。wake只触发已有 loop尽快检查，不创建另一套 poller。

## 7. Cloud notifications

`space_cloud::notifications` 是 App 进程级 owner，不依赖 Space Tab、Session Sidecar或 Registered Agent Connector。它合并两个只读来源：Cloud notification feed与本地 Task Comment locator；合并只发生在 UI snapshot层，不改变两边 authority。

- 匿名身份只接收公开公告；登录身份还接收私有 feed；
- receipt存于全局 notification state，Cloud部分按 origin和account隔离；不持久化私有 feed正文或target；
- login/logout/account switch/401先清空旧 account projection，再进行网络同步；
- read intent先本地落 pending，再向 Cloud幂等收敛；
- Cloud target只接受Rust校验后的 HTTP/HTTPS URL或 typed AppRoute；
- 本地 Task Comment不进入Cloud ACK，也不随Space环境切换。

## 8. Issue、资源与缓存语义

### 8.1 Issue identity

用户可见 Issue number由Cloud拥有，是 Space内稳定正整数；opaque issue id不具备展示编号语义。list/detail/Delivery都消费API返回的 number，缺失或非法不能通过解析id后缀降级。

assignee是持久责任，claim是执行层租约，Issue state是工作状态。完成/关闭不自动清除assignee；取消指派按Cloud领域规则同时收敛active claim与状态。

### 8.2 Renderer cache

`spaceStore`按 Space、query和cursor持有最近成功snapshot。event cursor只负责invalidating/revalidate：远端更新后重新读取 authoritative list/detail，而不是根据event payload直接拼接局部真相。

分页追加按id去重；请求失败保留最近成功数据并展示inline error。账号、origin或credential transition必须先隔离旧cache，不能让上一个环境/账号的数据短暂成为当前事实。

### 8.3 Skills、Tools 与 profile

Cloud拥有Skill package、Tool revision/icon和profile数据；Desktop只做安装、上传、下载与本地展示。Skill安装目标只能是global或current project，zip必须限制总大小、单项大小和entry数并防Zip-Slip；覆盖采用完整staging后原子目录交换，不做文件级合并。

用户与Registered Agent头像通过Cloud/R2对象模型暴露。Desktop上传走Rust multipart并校验本地文件；Renderer不直接持token或上传到公开object URL。公开头像URL不是credentialed attachment route，缺少服务端public asset配置时Cloud应拒绝发布对象而不是让Desktop猜fallback。

## 9. 文件与网络安全

所有Space网络请求由Rust `reqwest` 发起并统一添加client context：public client id、版本、device、platform、OS、locale与User-Agent。credential transition只依据结构化 credential kind和HTTP status；不得匹配自由文本错误或token过期时间猜测。日志只记录redacted binding/request id。

用户可控workspace路径先通过`validate_workspace_root`。附件IO满足：

- 只接受允许的普通文件，不跟随symlink/reparse point；
- 上传在inspect后提交时重新打开并再次校验，抵御TOCTOU；
- 下载流式执行大小限制，完整接收后才发布；
- parent目录逐级no-follow，staging/rename绑定同一安全namespace；
- CLI只访问current workspace，数量和单文件大小在读取前/过程中同时限制；
- multipart成功才把附件与Issue/comment绑定。

Space response在Rust单点解析为结构化`SpaceCommandError`。Renderer只负责本地化文案，不通过message内容恢复Cloud code或credential状态。

## 10. Plan 与 quota

账号plan和Space entitlement/quota完全由Cloud解析。Desktop只消费投影：

- account plan作用于账号拥有且没有独立override的Spaces；
-加入他人的Space不继承当前账号权益；
- Space-scoped limit使用`number | null`，`null`表示无限，字段缺失仅表示兼容数据不足；
-到期/撤销后存量保持可读，超额时只拒绝增加用量的mutation，删除/归档/释放额度仍允许；
- plan changed event只触发session/overview revalidate，不能由Renderer本地计算新quota。

Cloud内部entitlement、计量、D1 schema、运营API和发布流程不在Desktop文档中复制。

## 11. 关键验证

涉及Cloud/Desktop契约时至少覆盖：

- production/dev/mock capability隔离；
- user与Registered Agent actor fail-closed；
- user credential 三态、user-only 401 与 exact-session-binding CAS；
- origin/account/device切换不串cache或token；
- Delivery receipt/ACK幂等与exact Session origin；
- Connector poll和presence是两条独立语义；
- attachment symlink/reparse、大小限制与staging commit；
- protocol兼容由Cloud serializer和Desktop strict parser共同锁定。

Session origin与注入后的本地生命周期见 [`session_architecture.md`](session_architecture.md)。
