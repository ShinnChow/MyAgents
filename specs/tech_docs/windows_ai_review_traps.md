# Windows AI Review Traps

本文是从 macOS 开发或审查 Windows 相关改动时的 failure-seeking checklist。平台架构和 helper 由 [`windows_platform.md`](windows_platform.md) 拥有，WebView2 实测矩阵由 [`windows_cross_platform_review.md`](windows_cross_platform_review.md) 拥有；这里不保存事故、commit 或 release 历史。

先列出改动跨过的边界，再为每个边界指出现有 owner。没有 owner 时，先判断是否真的需要新抽象，不要在调用点散落 Windows guard。

| 边界 | 首选 owner / helper |
| --- | --- |
| machine-readable subprocess output | producer-side UTF-8 / base64 envelope |
| workspace identity | `normalizeWorkspacePathIdentity` / `workspacePathsEqual` |
| filesystem path ↔ URL | `pathToFileURL` / `fileURLToPath` 或 app resource protocol |
| Rust path → external consumer | `normalize_external_path` |
| Rust GUI 后台 subprocess | `process_cmd::new` / `spawn_tree` |
| executable discovery | `system_binary::find` 或具体 runtime locator |
| localhost HTTP | `crate::local_http` |
| WebView policy | `webview_policy.rs` / resource protocol / CSP |
| config write/fsync | existing config IO owner |

## Trap 1：把进程输出当成天然 UTF-8

PowerShell、OEM/ANSI code page、localized command和第三方程序都可能产生非 UTF-8 bytes。字节一旦被 SDK或Node错误解码成 string，Renderer无法恢复。

审查：

- 结构化 PowerShell输出使用 ASCII-safe envelope，例如 base64(UTF-8(JSON))；
- SDK shell在 child env设置 UTF-8 locale / Python编码，并通过受管 Bash prelude设置 code page；
- 用户可编辑 JSON在 file boundary剥 UTF-8 BOM；
- `from_utf8_lossy` 只用于人读诊断，不解析协议；
- encoding修复发生在 producer/process/file boundary，不发生在 UI。

Smell：`JSON.parse(stdout)` 紧跟 PowerShell、对 machine protocol使用 lossy decode、在消息渲染层替换乱码。

## Trap 2：把路径字符串当成单一 identity

Windows 同一路径可能表现为盘符大小写、正反 slash、trailing separator、UNC 或 `\\?\` long-path。Archive key、URL 和 OS path 又是不同命名空间。

审查：

- 跨 store比较 workspace path使用 shared identity helper；
- Map/Set key在建表与查找两端使用同一 normalization；
- ZIP/manifest relative key始终用 `/`，不能序列化 `PathBuf` 的 OS separator；
- `file://` 使用标准 URL helper，不手拼 prefix或读取 `URL.pathname`；
- Rust path跨到 Node/npm/spawn/URL前去掉 verbatim prefix；
- write-side尚不存在路径使用 lexical安全解析，不滥用 read-side canonicalize；
- junction/symlink测试使用 repo的 reparse-aware helper；
- 磁盘容量查询交给 filesystem owner，不用字符串 prefix猜 mount。

Smell：跨 owner raw `===`、inline slash replace、手拼 `file://<path>`、把 `to_string_lossy()` 结果直接当 archive key。

## Trap 3：把 shell quoting 当作协议

Git Bash、`cmd.exe`、PowerShell、`.cmd`、npm wrapper和Node argv的解析规则不同。

审查：

- executable、args、cwd分开传递，不拼 command string；
- prompt、JSON、多行/长文本和 shell-sensitive payload使用 `--prompt-file` / `--content-file` 等文件 handoff；
- Node侧调用 npm/npx走 wrapper-aware resolver；
- Rust GUI后台进程走 `process_cmd`，可执行文件走已有 locator；CLI mode 与 Terminal 分别由 console / PTY owner 创建；
- 测试包含空格、Unicode、引号、反斜杠、换行、`%` 和 metacharacters。

Smell：为了 Windows加 `shell: true`、把用户内容拼进命令、只有 inline text flag没有 file escape hatch。

## Trap 4：把 Tauri GUI 当作终端

Explorer启动的应用没有用户 interactive shell的 PATH/console/env语义。长生命周期进程还可能经 wrapper 派生后代。

审查：

- GUI拥有的短后台 child使用 `process_cmd::new`；会派生后代的 long-lived child使用 `spawn_tree` 并保留 `ChildTree`；
- CLI mode用 raw `Command` 继承用户 console；Terminal由 `portable-pty` / ConPTY管理，不能强行改走 `CREATE_NO_WINDOW`；
- Windows Job Object在初始线程 resume前绑定，确保 kill-on-close覆盖整棵树；
- normal shutdown按 live handle/owner清理，不扫描全机；
- prior instance确定死亡后的 recovery才允许 `process_cleanup` 枚举；
- localhost proxy bypass和Provider/general env在 spawn owner处构造；
- GUI不依赖裸 PATH查 node、git、npm或runtime。

Smell：在非 CLI/PTY 等明确 owner 例外中裸用 `std::process::Command::new`、`taskkill /IM`、PowerShell/WMI进程扫描、只 kill root PID、`cmd /c` 包住长生命周期服务。

## Trap 5：把 WebView2 当成换了字体的 WKWebView

CSP、custom protocol、`srcdoc`、clipboard、scrollbar和OS child WebView合成都会分歧。

审查：

- attachment使用 `myagents-resource` protocol，不把 Sidecar loopback URL直接喂给 subresource；
- widget外部库只能走已登记的本地 inline source；
- 所有 WebView builder共用 native scrollbar policy；
- Browser child geometry持续对账，transition/overlay期间按 contract隐藏；
- clipboard调用 shared fallback helper；
- CSP使用标准 directive，并包含 Windows IPC origin；
- macOS-specific input guard在安装期平台门控。

真机矩阵见 `windows_cross_platform_review.md`。

## Trap 6：忽略短暂但真实的文件竞争

Defender、indexer、OneDrive和其它同步工具可能在 rename/fsync/replace间短暂持有文件。

审查：

- 配置写入沿现有 lock + reread/merge + temp/rename路径；
- 只对已知 transient sharing violation使用有界退避；
- 不能把 permission denied一律重试或静默成功；
- symlink/reparse point在 source、ancestor和publish前再次验证；
- updater handoff在安装前证明进程和关键文件锁都清零；
- cleanup target使用明确受管目录，不能宽泛递归用户 HOME。

Smell：直接覆盖 config、unbounded retry、catch后忽略、把所有 `AccessDenied` 解释为杀毒软件。

## Trap 7：混淆 Runtime identity 和环境

系统 CLI、managed runtime、bundled Node和Provider-backed runtime可能有相同 executable name但不同 owner、版本、auth和proxy。

审查：

- Session birth冻结 runtime + source + model的完整 execution identity；
- runtime-backed Provider不进入 builtin ProviderEnv；
- probe/status与实际 spawn使用同一 locator和环境 policy；
- `envPolicy` 只接受 current literal，未知值fail-safe；
- config变化通过 lifecycle owner replacement，不原地篡改活跃 child env；
- absolute managed path不回退到 PATH同名 binary。

Smell：只比较 `runtime === "codex"`、status探测系统 binary但执行 managed binary、把 app proxy与terminal proxy混为一谈。

## Trap 8：用 macOS证据替代 Windows artifact

macOS unit test可以证明 pure policy，不能证明NSIS、WebView2、Authenticode、Job Object、`.cmd` 或 resource layout。

审查：

- pure boundary有 deterministic test；
- 需要 OS行为的结论明确标为 Windows smoke，不写成已证实；
- release-like测试使用真实 bundle/resource path和签名流程；
- installer/updater测试覆盖有空格/Unicode的安装目录、文件锁与重启；
- smoke在无系统 Node/Python/native DLL fallback下运行，证明 bundled authority；
- 构建指南拥有命令和 artifact清单，本文件不复制。

## Review 输出要求

Windows review 应报告：

1. 改动跨过了哪些 Windows-specific boundary；
2. 每个 boundary 的 owner/helper；
3. 是否存在上述 smell；
4. deterministic test 与 Windows-only smoke 各证明什么；
5. 尚未真机验证的结论必须明确标注，不把静态推理写成 ground truth。

只在出现新的、可复现且跨任务会重复的 failure class 时增加 Trap。单个 bug症状、旧 issue和 release记录不进入本文。
