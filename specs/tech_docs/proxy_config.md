# 代理配置架构

MyAgents 的代理不是一个 process-global 开关，而是按网络请求 owner 分流。本文定义 current scope、baseline 和 helper；Provider 的认证与模型路由见 [`third_party_providers.md`](third_party_providers.md)。

## 配置与 scope

`config.json.proxySettings` 的权威类型在 `src/shared/config-types.ts`：

```json
{
  "enabled": true,
  "protocol": "http",
  "host": "127.0.0.1",
  "port": 7890,
  "scope": {
    "mode": "custom",
    "generalRequests": true,
    "providerIds": ["anthropic-sub"]
  }
}
```

- `protocol` 只接受 `http`、`https`、`socks5`；
- `mode: all` 表示 general 与所有 Provider owner 使用应用代理；
- `mode: custom` 分别选择 `generalRequests` 和 `providerIds`；
- 未开启、未选中的 owner 使用 inherited system / parent-process network baseline，不等于强制直连。TUN、VPN 和系统代理仍自然生效。

读取旧 custom scope 时，如果缺少 `generalRequests`，默认视为 `true`；缺字段且 Provider 列表也为空的旧空 scope 归一化为 `all`。这是仍在生效的磁盘兼容规则，新写入必须使用完整 current shape。

## Owner 模型

```text
config.json proxySettings
       |
       +-- general owner
       |     updater, resource/runtime downloads, model metadata,
       |     generic MyAgents HTTP, Plugin Bridge
       |
       +-- provider owner(providerId)
             Builtin SDK, OpenAI Bridge upstream, provider probe,
             managed/runtime-backed provider process
```

请求归类依据是拥有该请求的产品状态和 lifecycle，不是 hostname。一个 opaque SDK / Runtime 进程内部代发的 remote MCP、connector 或 tool traffic 无法再按 packet 细分；当前架构不声称代理 WebView、系统浏览器或所有第三方子流量。

## Localhost 永远直连

Renderer 与 Sidecar 的控制面、Rust 到 Sidecar、IPC 及内部 HTTP 必须排除代理。Rust 调用统一使用 `crate::local_http`；不要在调用点自己创建普通 reqwest client 再期望 `NO_PROXY` 恰好正确。

`NO_PROXY` / `no_proxy` 至少合并 `localhost`、`127.0.0.1` 和 `::1`。IPv6 parser 要接受有效的 loopback URL/host 表示，不能把带方括号的 URL authority 文本当成 host value 存入 matcher。

## Rust helper

`src-tauri/src/proxy_config.rs` 是 Rust scope 与 client/subprocess policy owner：

| 场景 | 入口 |
| --- | --- |
| general reqwest | `build_client_with_proxy` |
| Provider reqwest | `build_client_with_proxy_for_provider` / blocking variant |
| general subprocess | `apply_to_subprocess` |
| Provider subprocess | `apply_to_subprocess_for_provider` |
| loopback | `crate::local_http` |

`read_proxy_settings()` 只回答“应用代理配置是否有效”，不能替代 general-aware decision；Provider 可能在 `generalRequests=false` 时仍被选中。

应用代理注入子进程时同时保留覆盖前的 inherited proxy snapshot，并标记 `MYAGENTS_PROXY_INJECTED`。未选择应用代理时保留 inherited proxy vars，只合并 localhost exclusion；不能擅自删除 inherited `ALL_PROXY`。

## Node 三基线

`src/server/proxy-state.ts` 同时维护：

1. immutable `inheritedProxySnapshot`：Rust / MyAgents overlay 之前的 proxy env；
2. app-proxy overlay：当前应用代理 URL；SOCKS5 时是本地 bridge URL；
3. `process.env`：当前 general owner 的有效 baseline。

Provider 选中时从 overlay 构造 env，未选中时从 immutable inherited snapshot 构造。禁止从已经被 general policy 改写的 `process.env` 反推 Provider baseline。

Node generic HTTP 必须走 `fetchWithGeneralProxy()`；需要 cancellation/deadline 时走 `cancellableFetch()`。这些 helper 使用 package-pinned dispatcher，并在 baseline 改变后退休旧连接池。普通 `fetch` 不保证消费 `HTTP_PROXY`。

Plugin Bridge 是受控例外：社区插件无法被强制改用 helper，所以 Bridge 在加载插件前安装同一 general dispatcher 为 process-global fetch/dispatcher，并在 Channel lifecycle replacement 时重建。

## Provider 路径

Provider-owned Node 路径使用：

- `applyProviderProxyPolicyToEnv(env, providerId)`：SDK / Runtime subprocess；
- `getProxyForProviderUrl(providerId, url)`：Bridge、probe 等直接 HTTP。

Builtin Anthropic subscription 的 ID 是 `anthropic-sub`。代理 owner 只决定网络 baseline，不因此接管 Claude Code native OAuth credential。

OpenAI-protocol Provider 的 SDK subprocess 只访问 Sidecar loopback。`buildClaudeSessionEnv()` 必须从该子进程 env 剥离所有 proxy vars，避免 SDK 把 `127.0.0.1` 送入代理；Bridge handler 再根据 bridge token 找到 `providerId`，以 Provider-aware helper 访问真实 upstream。Bridge 不能用 general `process.env` 代替 Provider decision。

## SOCKS5 bridge

多数 SDK/子进程只稳定支持 HTTP proxy。应用配置为 SOCKS5 时，Sidecar 建立稳定的本地 HTTP-to-SOCKS5 bridge：

- bridge 从完整 current settings 初始化，不从 general env 反推；
- general 与 Provider owner 分别决定是否使用该 bridge；
- `generalRequests=false` 但有 Provider 被选中时，bridge 仍存在但不会写入 general env；
- endpoint 变化后新连接使用新目标，既有 tunnel 自然排空；
- 没有任何 app-proxy consumer 时停止接收新连接，不强制切断活跃 tunnel；
- generation fence 丢弃旧配置的 callback。

## External Runtime envPolicy

Claude Code / Codex / Gemini 等 external Runtime 还可在 Agent 配置选择：

| 值 | 语义 |
| --- | --- |
| `myagents` | 使用 Sidecar 当前 general baseline |
| `terminal` | 移除 Sidecar proxy vars，再恢复 interactive shell warmup 检测到的 proxy env |

`src/server/runtimes/env-utils.ts::resolveAgentEnvPolicy()` 是磁盘读取与字面量校验入口。未知值 fail-safe 到 `myagents` 并记录 warning；调用方不得裸 cast。`terminal` 没检测到 shell proxy 时形成无显式 proxy env，但仍可能通过 TUN/VPN 路由。

已打开的 PTY 拥有自己的出生 env，配置变化不会重写它；新 Terminal 使用新策略。

## 配置变化生命周期

- Settings 在 Rust 配置写锁内更新 `config.json`；
- 活跃 Sidecar 接收 hot proxy state propagation，后续 generic 请求和新 Provider subprocess 使用新 policy；
- Plugin Bridge 与 IM Channel 通过各自 keyed lifecycle lock 在安全空闲边界 replacement，不能并发启动第二实例；
- 连续设置变化由 generation / reconciliation 收敛到最新磁盘配置；
- 代理变化不能打断已建立的用户 Terminal 或把正在执行的 Provider turn 临时改成另一套 env。

## 安全例外

用户提供的 raw ZIP URL 经过 public-address validation 后使用 DNS-pinned direct dispatcher，避免代理侧重新解析打开 SSRF / DNS rebinding 窗口。该路径既不使用 app overlay，也不消费 inherited env proxy；它是输入安全边界，不是按域名扩展 general scope。

应用自有浏览器资源下载只访问签名版本锁中的 exact HTTPS URL，禁止 redirect，并始终执行 size、SHA-256 与安全解压校验。只有 transport failure 才允许对同一锁定 URL 做一次受限直连重试；确定性 HTTP 错误不伪装成代理故障。

## 验证

测试应覆盖：

- `all` / `custom`、legacy missing `generalRequests` 与空 scope 归一化；
- general 和 Provider 的 overlay / inherited 组合；
- HTTP/HTTPS/ALL_PROXY 选择及 localhost/IPv6 bypass；
- SOCKS5 bridge 在 general-only、provider-only 和 endpoint replacement 下的 lifecycle；
- OpenAI Bridge 的 loopback proxy stripping 与 upstream Provider policy；
- external `envPolicy` 字面量验证；
- config hot propagation、Channel replacement generation 和 PTY 不变；
- raw ZIP DNS-pinned direct security exception。

排查时读取 unified log 中的 `owner=general` / `owner=provider` 与 `path=myagents-proxy` / `path=inherited`，不要只观察 process env 的某一个变量。
