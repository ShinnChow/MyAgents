# Multi-Agent Runtime 架构

> 本文定义 builtin、Claude Code、Codex 与 Gemini 如何接入同一 Product Session。Runtime 的安装版本、完整 RPC schema 和字段枚举以锁文件、生成类型与实现为准，不在本文维护副本。

## 1. 总体边界

```text
routes
  -> session-engine/selector.ts
      -> builtin-adapter.ts  -> agent-session.ts       -> Claude Agent SDK
      -> external-adapter.ts -> external-session.ts    -> AgentRuntime
                                                         |- Claude Code CLI
                                                         |- Codex app-server
                                                         `- Gemini ACP
```

`SessionEngine` 是 route 面向当前 Session Runtime 的唯一 facade。Route 只做请求校验和响应映射，不自行判断 builtin/external，也不直接 import Runtime owner。

Runtime 抽象统一的是产品行为，不是 mutable state：

- Product Session identity、metadata 与 transcript 仍由 Session 层拥有；
- builtin 和 external 各自拥有进程、queue、turn、config 与 terminal state；
- `src/server/session-core/` 只共享无副作用 policy；
- 不为某个 Runtime 不支持的能力建立伪对称 stub；adapter 返回明确 capability/unsupported 结果。

Session identity、恢复与配置 snapshot 见 [`session_architecture.md`](session_architecture.md)。

## 2. SessionEngine 契约

`src/server/session-engine/` 统一承担以下产品语义：

- desktop、IM、Inbox 与 scheduled turn 的 admission；
- stop by exact domain owner and queue id；
- live state、stream replay、latest result、completion terminal 与 config snapshot 读取；
- Rewind、Fork、desktop reset 与已证明的 surface migration；
- model、permission、reasoning、MCP、Agent、Plugin 与 interaction scenario 配置入口；
- external-only 的 pre-warm、diagnostics、native compact 与 retry 能力检查。

`product-session-binding.ts` 是 Product Session prepare/commit/rollback 的事务入口。adapter 只能在完成自身 Runtime 清理和绑定后提交产品 identity；SDK UUID、Codex thread id 等 native identity 不进入这里。

`runInjectedTurn()` 等同步入口必须等待真实 terminal settlement，并使用 adapter 的成功分类。`isBusy() === false` 或进程退出都不等于 turn 成功。

所有跨 Runtime read API 返回 immutable snapshot。REST restore、BackgroundCompletion、通知与 Task/Goal 不再猜 Runtime 类型，也不读取 owner internal。

## 3. 中性合同

### 3.1 `AgentRuntime`

外部 Runtime 实现 `src/server/runtimes/types.ts` 中的 `AgentRuntime`：检测与模型发现、启动/恢复、发送、权限响应、停止，以及可选的 steer/config/native operation。接口只描述 transport 能力，Session lifecycle 由 external-session owner 编排。

### 3.2 `UnifiedEvent`

各协议先归一化为 `UnifiedEvent`，再由 external session 转为产品事件和 transcript：

| 类别 | 产品语义 |
|---|---|
| text / thinking | 流式内容块 |
| tool use / result | 工具生命周期与附件 |
| permission / question | 结构化交互请求 |
| session / turn terminal | 进程、turn 与成功状态 |
| usage | turn token 与 context snapshot |
| runtime tool catalog | 当前 generation 实际加载的工具目录 |
| diagnostics | auth、env、MCP、extension 等运行状态 |
| agent plan | Runtime 原生计划的 transient UI 投影 |

协议 delta 不写原始正文日志；成功 terminal 后只输出有界、脱敏的 assistant summary。新增 Runtime 事件应先进入这个中性合同，不在 Renderer 建协议专属分支。

### 3.3 类型归属

跨 Runtime 或跨进程的类型放在最窄的中性模块：

- `src/shared/types/runtime.ts`：`RuntimeType` 与共享展示类型；
- `src/server/provider-types.ts`：Server provider identity/env 类型；
- `src/shared/types/tool-input.ts`：Renderer/Sidecar 共用的工具输入；
- `src/server/session-core/`：queue、terminal、activity、MCP 与 config pure policy。

中性类型不拥有进程、SessionStore、SSE 或文件系统副作用。

## 4. Runtime identity 与来源

外部 Runtime 除 `RuntimeType` 外还带 `runtimeSource`：

| Source | Authority |
|---|---|
| `system-cli` | 用户安装、登录并配置的本机 CLI |
| `managed-provider` | MyAgents 管理二进制、安装、登录与可投影扩展 |

同为 Codex，两个 source 也不能复用进程或混用配置。Rust 在一次 Sidecar ensure attempt 开始时解析完整 `RuntimeIdentity(runtime + source)`；复用校验与 spawn 使用同一快照，不能在中间重新读取 Agent 配置。

显式 system CLI 选择优先于 provider compatibility projection。Managed provider 的 readiness 由自己的 provider gate、安装清单与认证状态裁决，不依赖实验室的 system CLI Runtime 开关。

owned desktop/Task Session 持久化执行 identity；IM 与 Agent Channel 只固定 Runtime identity，model/provider/permission/MCP 在每条消息 admission 时 live resolve。Analytics 和 drift detection 同样必须携带完整 source，不能把 managed 与 system usage 合并。

Managed Runtime 的目标下载版本以 `src/shared/managed-codex-runtime.json` 为唯一锁定源；当前进程使用安装器已经原子发布并校验的 installed identity。更新下载期间不得因为目标锁变化而阻断现有健康版本或已有 Session。

## 5. 各 Runtime 协议

### 5.1 builtin Claude Agent SDK

builtin 直接调用 SDK，并通过常驻 `messageGenerator()` 复用一个 Query。`agent-session.ts` 是 public facade；真实 lifecycle、queue、turn、config 与 transcript owners 位于 `src/server/builtin-session/`。

SDK `system_init`、terminal、MCP status 与 background task 都必须绑定 exact Query authority。旧 Query 或旧 generation 的迟到事件不能更新当前 Session。MCP startup observation 是 soft gate；MCP map mutation/replacement 是 turn-boundary correctness fence。详细规则见 [`session_architecture.md`](session_architecture.md)。

### 5.2 Claude Code

Claude Code 使用 `-p` 模式与 NDJSON stdio。每个 turn 启动一个进程，后续 turn 通过 native session id resume：

```text
stdin user message
-> stream_event / control_request / system
-> result
-> process exit
```

MyAgents 把 native stream 归一化为 UnifiedEvent，并通过 SessionStart hook 获取可靠的 session id。权限模式使用 CLI 当前支持的 native vocabulary；产品权限只在 Runtime boundary 做可证明的映射。

IM/Agent Channel 需要 native-card `AskUserQuestion` 时，启动策略必须保留 stdio permission channel。full-agency 对普通工具可以 fast-path，但不能用 bypass mode 吞掉结构化提问。

### 5.3 Codex

Codex 使用 JSON-RPC 2.0 app-server，一个进程在 Product Session 生命周期内持久存在。adapter 拥有 initialize、thread start/resume/read/fork、turn start/steer/interrupt、权限请求与订阅关联。

一个 Session Sidecar 最终只绑定一个 root thread。RPC response 和 notification 可乱序到达，turn owner 必须按 thread、turn 与 caller message identity 关联，不能仅凭“收到 completed”提交错误 turn。

Codex Rewind/Fork 只在 runtime capability 和精确 root-turn anchor 同时可用时开放：

- root `turn/start` 关联 Product user message id；
- 成功 terminal 后持久化 native turn anchor；
- Rewind 保留 Product Session id，截断 MyAgents transcript并切换 native branch；
- Fork 创建新 Product Session 并复制截止边界的产品 transcript；
- native branch 创建成功后解除 source app-server 的临时订阅；
- process termination 不确定时不提交产品 mutation。

不得用 experimental rollback、Renderer mirror 或猜测的 previous-turn id 替代 native history。产品 transcript 仍由 SessionStore 拥有，不从 Codex rollout 反向重建。

Codex Server → Client request 使用显式 allowlist。升级 app-server 时以当前 binary 生成的 schema 核对请求和 notification；未知 request fail closed。approval 与 structured question 可并发，后端按 request id 持有多个 pending，Renderer 以 FIFO queue 投影，不能使用单槽位覆盖。

工具与子 Agent item 在 adapter 内映射为标准 tool/content blocks：command、file change、MCP、dynamic tool、web search、image view/generation 与 collab-agent 都走同一 transcript/attachment pipeline。raw protocol payload 不越过 adapter，也不写日志。

### 5.4 Gemini

Gemini 使用 ACP JSON-RPC stdio，并保持一个可多轮使用的进程。adapter 负责 initialize/session new/prompt、模型与 mode RPC、权限/提问请求及 terminal 映射。

系统提示词通过当前 Product Session 的 deterministic `GEMINI_SYSTEM_MD` 临时文件合并注入，不能修改用户文件或使用跨 Session 的共享文件。进程退出不删除该文件：Windows `.cmd` launcher 退出不能证明 grandchild 已完成读取，迟到的旧进程 callback 也不能删除 retry 复用的同名文件；创建新 Session 文件时只清理超过一小时的 stale `session-*.md`。

Gemini 模型与权限在 turn boundary 通过 native session RPC 应用；reasoning effort 未建立等价能力时返回 unsupported，不用 prompt 或重启伪装支持。

## 6. External Session owner

`src/server/runtimes/external-session.ts` 是 public facade。状态按职责拆入同名目录：

| Owner | 职责 |
|---|---|
| `lifecycle.ts` | process/start/pre-warm/stop 与 generation |
| `operation-queue.ts` | message 与 config operation 的 FIFO、steer fallback |
| `turn-lifecycle.ts` | promotion、running、terminal 与 finalization gate |
| `runtime-config.ts` | desired/effective config 与 source filtering |
| `transcript-persistence.ts` | user append、assistant commit、retry/rewind mutations |
| `content-blocks.ts` | UnifiedEvent 到持久内容块 |
| `interactive.ts` | permissions、questions、IM/Inbox/watch association |
| `extensions.ts` | Managed Codex extension projection |

facade 负责组装 owner，不重新保存同一份 mutable state。Route 和 SessionEngine adapter 不直接 import这些内部模块。

### 6.1 admission 与序列化

每个 ingress 先创建包含 Product user message、config snapshot、queue id 与 caller metadata 的 operation。所有路径共享同一 admission order：

1. 等待正在进行的 start/pre-warm；
2. 在持久进程中序列化 active turn；
3. 等待上一 turn 的 transcript finalization settlement；
4. 对 Task/Goal 等执行 exact domain dispatch claim；
5. 在 transport 前再次验证 process generation 与 cancellation token。

guard accepted 之前不展示伪 user bubble、不写 transcript、不启动 watchdog。transport write 开始后的 error 只表示 acknowledgement 不确定；必须尝试 exact stop，未确认终止时保留 process、queue binding 和 domain owner，不能自动重放。

user message 在 transport 接纳后尽快 append；assistant content 在成功 terminal、附件保存与 finalization gate 内一次提交。下一 turn 和同步 caller 只有在 gate settle 后才能读取 latest assistant result。

### 6.2 realtime 与 turn-boundary queue

desktop response mode 决定 busy 时尝试 same-turn steer 还是排到 turn boundary。是否可 steer 由 `AgentRuntime` 静态能力与当前 process generation 的动态 target共同决定，不硬编码 Runtime 名称。

native steer 明确返回“未接收”时，同一个 operation 可以按原 admission order降级到 turn-boundary queue；timeout、process exit 等不确定错误不能自动重放。same-turn steer 不应用新的 model/permission/reasoning snapshot。

IM、Inbox、Task 与 scheduled turn 保持 turn-level admission，不借用 desktop steer。用户显式 force-start、取消与 Stop 都由 operation queue 按 exact queue id重排或结算，不能清除无关后续项。

### 6.3 配置变更

model、permission、reasoning 与 capability changes 都先进入 source-aware config policy，再成为 operation：

- active turn 保持其 admission snapshot；
- config operation 在下一个 turn boundary 先于后续 message 应用；
- IM sync 不覆盖 owned Session snapshot；
- 需要 replacement 的变化只在 idle boundary 换代，当前 turn 不受影响；
- native config RPC 失败时阻止使用旧配置启动已排队消息。

重复 hydration 或相同 effective config 必须 no-op。不能把“收到一次 POST”当配置真的变化，否则 adopt 已预热 Session 会被无意义重启。

### 6.4 pre-warm

Pre-warm 只适用于可保持 idle process 的 Codex/Gemini；Claude Code 每 turn 启动进程，不预热。

pre-warm 建立真实、可由后续首条消息复用的 process/thread，但不把 Session 标为 running、不启动 per-turn watchdog，也不凭空发布 Product metadata。首个真实 turn 在统一 materialization helper 中提交 metadata 和 user transcript。

`isBusy()` 表达 turn activity；process liveness 由独立状态表达。idle pre-warm process不能阻塞 Goal、Memory 或其它需要 idle Session 的调用方。失败仅记录日志，真实 send 仍走正常 start/resume；cross-runtime mismatch、stale native id 或缺失 Product metadata 均 fail closed。

## 7. Managed Codex 扩展

Managed Codex 由 MyAgents 拥有 app-server launch config，所以可以把 Product capability 投影进去；system-cli Codex 继续由用户配置拥有，不接管。

`external-session/extensions.ts` 从当前权威配置编译 immutable snapshot，并用 desired/effective revision 管理 process generation：无进程等待下次启动，active turn 延后到 idle，idle 时安全 replacement。旧 generation 的结果不能回写新 revision。

| Product capability | 投影 |
|---|---|
| Skills | enabled winner 的临时精确目录、extra roots 与 native read-back |
| Commands | admission 时展开为 Runtime prompt；transcript 保留用户原始命令 |
| Agents | native agent config，只映射能忠实表达的字段 |
| external MCP | 从服务端 definition 编译 launch config |
| in-process MCP / IM bridge | generation-bound dynamic tool dispatcher |
| Plugins | 只编译 manifest 声明且当前 Runtime 可表达的组件 |

Renderer 对 MCP 只提交 ID intent；Sidecar 必须重新读取 command/env/url definition。secret 只进入进程环境或 apply fingerprint，不进入 argv、revision、diagnostics 或日志。

单个 Skill/MCP/Agent/Plugin 无法解析或不受支持时，只排除该组件并产生结构化诊断；基础 Runtime generation 仍可用。只有顶层 Runtime 无法启动/应用时才阻断 Chat。依赖 `ProductSystemSkillRequirement` 的 turn 是明确例外：它必须核对 exact app-owned candidate、内容 digest、inventory revision 与 native read-back，已知不可用时拒绝该依赖 turn，但不使普通会话失效。

动态工具目录绑定 native thread birth 和 process generation。未知、已删除、参数无效、重复或 stale tool call 只失败该调用；不得因 catalog 漂移清空 transcript、制造空 thread 或建立第二套 Agent loop。

## 8. Skill、Command 与工具能力

`AgentConfig.capabilitySelection` 是项目选择的持久化 authority。`project-capabilities.ts` 扫描 Project 与用户候选，按 canonical name 选择 project > global winner，再应用 disabled intent。局部候选损坏只淘汰该候选，不阻断 workspace。

Command 的 selection identity、展示名与 invocation name 是三种不同事实。invocation name 由 source-relative path稳定派生；修改 frontmatter/H1 不得改变调用协议。设置、Sidebar、slash menu 与 Managed Codex compiler消费同一个 capability snapshot。

`.claude` symlink 是 system CLI 的兼容投影，不是选择 authority。外部 process记录启动时采用的 capability revision；下一次 admission 发现 revision 改变时在 idle boundary replacement，不依赖本 Sidecar 是否刚好执行了文件写入。

slash menu 按真实 Runtime capability投影：

- `/goal` 是 Runtime-neutral 产品动作；
- Claude SDK native commands 只在 builtin 显示；
- Managed Codex只显示已经适配的 native command；
- unsupported command 隐藏，而不是发送一段模拟 prompt；
- `runtime_tool_catalog` 只描述当前 generation 实际加载的工具，不反向成为 workspace 配置 authority。

## 9. 诊断与环境

外部 Runtime 的实际环境可能与用户交互式终端不同。所有启动与 CLI diagnose共用 `resolveAgentEnvPolicy(workspacePath)`：

| proxy policy | 语义 |
|---|---|
| `myagents` | 使用 Sidecar 启动时由 MyAgents 注入的 proxy 环境 |
| `terminal` | 使用 shell warmup 捕获的交互式终端 proxy 变量 |

未知或旧字面量回落到安全默认，不能通过类型断言绕过 resolver。诊断 snapshot 只暴露有效 proxy presence、PATH 前缀、cwd、shell 和结构化 RPC 状态，不记录 secret 或完整环境。

Codex 在 Session 启动后异步收集 auth、feature、MCP 与 app 状态，并通过 `runtime_diagnostics` 投影。单个诊断 RPC 失败不阻断首轮；只有 producer 明确标记的顶层阻断状态显示 Chat banner。Renderer 不按失败数量或组件状态自行提升 severity。

Runtime tool catalog 是独立的可变 capability snapshot；只包含当前 native Runtime 已确认可用的工具。查询暂时失败保留仍健康的上一 snapshot，明确 failed/cancelled 才撤回对应 server。广播前必须校验 process generation，避免退出进程的迟到诊断污染新 Session。

CLI 诊断命令与真实 Session 启动使用同一个 env resolver 和 adapter probe。命令入口见 [`cli_architecture.md`](cli_architecture.md)。

## 10. Context 用量

Context 指示器展示最近一次主模型 API 调用的 input-side 占用，不是整个 turn 的累计 token。否则工具循环会重复计算上下文并严重高估。

| 系列 | 归一化 |
|---|---|
| Anthropic（builtin / Claude Code） | ordinary input + cache read + cache creation |
| OpenAI（Codex） | Runtime 已包含 cached 的 input total，不再重复相加 |
| Gemini | Runtime 提供的 per-request input tokens |

分母优先使用 Runtime 报告的窗口，其次模型注册表，最后产品默认值。OpenAI Bridge 必须先把 total input 拆成与 Anthropic 互斥的 ordinary/read/create 分区，防止下游重复计算 cache。

external adapter 只在 UnifiedEvent 显式给出 `contextOccupiedTokens` 时广播 context usage；缺失时宁可不显示，也不拿 running total/turn total 猜测。turn settlement 的同一 snapshot同时写入 Session metadata供重开恢复，并校验 source 与 Session Runtime 一致。

native compact 是 capability，不是所有 Runtime 的共同功能。builtin 走 SDK command；Managed Codex 走 SessionEngine native compact operation并隔离 control turn事件；其它 Runtime 没有等价语义时不展示入口。

## 11. 安全与日志

- Runtime binary、RPC schema 与 CLI flags 必须从当前安装版本的类型/生成物核对，不凭记忆维护。
- prompt、tool delta、raw NDJSON/JSON-RPC、provider error body 与 secret 不进入常规日志；只记录长度、hash、枚举与不可逆摘要。
- per-turn watchdog 只覆盖 active turn，不能杀死合法 idle pre-warm process。
- path、attachment、MCP template 与 subprocess env 使用共享安全 helper，不在 adapter 复制一套校验。
- Runtime mismatch 在 restore/pre-warm/send 三个入口都要检查，防止 native history 串入另一 Runtime。
- external terminal 只以 adapter 的真实 success result为成功；stale assistant text 不能被 Task/Goal/Heartbeat 复用。

## 12. 关键实现

| 路径 | 职责 |
|---|---|
| `src/server/session-engine/` | Runtime selector、adapters 与产品级 facade |
| `src/server/session-core/` | 跨 Runtime pure policy |
| `src/server/runtimes/types.ts` | `AgentRuntime`、`UnifiedEvent` 与中性 capability |
| `src/server/runtimes/factory.ts` | Runtime detection 与工厂 |
| `src/server/runtimes/claude-code.ts` | Claude Code NDJSON adapter |
| `src/server/runtimes/codex.ts` | Codex app-server adapter |
| `src/server/runtimes/gemini.ts` | Gemini ACP adapter |
| `src/server/runtimes/external-session.ts` | external public facade |
| `src/server/runtimes/external-session/` | external lifecycle、queue、turn、config、content、interactive 与 extension owners |
| `src/server/project-capabilities.ts` | Project/global Skill 与 Command winner snapshot |
| `src/shared/managed-codex-runtime.json` | Managed Codex target version lock |
| `src/shared/contextUsage.ts` | Context usage归一化 pure policy |
| `src/renderer/components/RuntimeDiagnosticsBanner.tsx` | Runtime 诊断投影 |

工具附件的 current wire、落盘与展示规则见 [`tool_attachment_pipeline.md`](tool_attachment_pipeline.md)。
