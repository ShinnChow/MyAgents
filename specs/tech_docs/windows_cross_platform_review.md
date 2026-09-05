# Windows WebView2 跨端验证契约

本文定义 macOS/WKWebView 与 Windows/WebView2 会发生系统性分歧的 UI 边界，以及当前实现应在 Windows 真机证明什么。它不是某次 review 的 finding 列表；待办和修复历史不在这里维护。

## Engine 边界

Windows 使用 WebView2（Chromium），macOS 使用 WKWebView。不能依据其中一个平台的表现推断另一个平台在以下方面相同：

- CSP 对 `srcdoc` iframe 和 subresource 的继承；
- custom protocol URL 形态；
- native scrollbar style 与占位宽度；
- OS child WebView 的合成和 geometry；
- clipboard permission / focus；
- DPR、forced colors、software rendering 和系统无障碍设置。

跨端修复应归位到 protocol、native policy 或共享 helper，不在单个组件加 platform-specific URL/CSS 猜测。

## Tool attachment

工具产物由 app-owned resource protocol 提供：

| 平台 | URL |
| --- | --- |
| macOS / Linux | `myagents-resource://tool-attachment/<session>/<turn>/<file>` |
| Windows | `http://myagents-resource.localhost/tool-attachment/<session>/<turn>/<file>` |

`src/renderer/utils/toolAttachment.ts` 验证 Session scope 后调用 `resolveMyAgentsResourceUrl()`。Rust `attachment_protocol.rs` 做 path normalization、scope 与 file safety。Renderer 不再把 Sidecar loopback URL直接放进 `img/src` 或 `media/src`。

Windows smoke：

- image/audio/tool attachment可显示、下载和重开历史；
- CSP console无 `img-src` / `media-src` 拒绝；
- Session mismatch、`..`、encoded separator 和非法 filename fail closed；
- legacy resource URL只在 canonicalization boundary接受。

## Widget sandbox

Widget运行在 `sandbox="allow-scripts"` 的 `srcdoc` iframe。WebView2 会继承 top-frame CSP；opaque origin 下外部 CDN script和 local `self` script都不能作为可靠执行路径。

`widgetLibraries.ts` 在 render 时识别受信的 Chart.js、D3 和 Lucide CDN引用，lazy-load app bundle中的 UMD source并以内联 script替换：

- source不写入 Session history；
- library load promise缓存，失败后逐出以允许重试；
- 内联前转义 `</script`；
- 未登记 library 保持原样，并通过 widget error surface显式失败，不能扩大 top-level CSP 放行任意 CDN。

Windows smoke覆盖三种 registered library、unknown library的可诊断失败、offline render和历史重开。

## Native scrollbar

`src-tauri/src/webview_policy.rs` 是 scrollbar style 的唯一 owner：

- Windows：`FluentOverlay`；
- macOS / Linux：platform `Default`。

所有主窗口、浮球、Companion、Shield 和 Browser child builder必须调用同一 policy；WebView2 共用 data directory时 style不一致会造成创建冲突。Rust source guard枚举 builder以防漏配。

Renderer不模拟 scrollbar hover/drag可见性，也不全局强制窄透明 thumb。需要布局稳定的主滚动面可保留 `scrollbar-gutter: stable`，作为旧 Runtime / classic scrollbar fallback；它不能创建第二个 scroll owner。

Windows release-like smoke需覆盖 mouse/touchpad、thumb drag、Windows 10/11、light/dark、100/125/150% DPI、always-show-scrollbar、High Contrast，以及长会话 Virtuoso和文件树宽度不跳动。

## Browser child geometry

右侧浏览器是 OS child WebView，不参与 React CSS transition 合成。`BrowserPanel.tsx` 的 current contract：

1. WebView alive且当前 Tab可见时，常驻 `requestAnimationFrame` reconciler读取 DOM rect；
2. rect改变才发 `cmd_browser_resize`；
3. 同一 lifecycle token只允许一个 in-flight resize，保持顺序；
4. 失败清空 last-synced state，下一帧重试；
5. split drag、width transition或 overlay期间隐藏 native view；
6. 隐藏期间仍更新 Rust cached geometry，重新 show时立即使用当前 rect；
7. lifecycle token阻止旧 generation命中新 WebView。

不能退回 ResizeObserver-only、`transitionend` 单次采样或“若干稳定帧后停止”的启发式。窗口 resize、百分比宽度、overlay位移和未来布局来源都是开放集合，最终 geometry必须由持续对账保证。

Windows smoke反复开关/拖拽 split、resize窗口、切 Tab、显示 overlay和快速销毁重建，确认无撕裂、旧 view闪现、永久中间帧或 IPC 无界并发。

## Clipboard

普通文本复制统一使用 `src/renderer/utils/clipboard.ts::copyPlainText`：

- 先尝试 Async Clipboard；
- WebView2 因 focus/permission拒绝时，在同一用户动作内回退 hidden textarea selection；
- 两条路径都失败则 reject，调用方不能显示成功。

富文本/Markdown helper最终也复用该 plain-text边界。测试覆盖 primary reject + fallback success以及双失败不误报。

## DPR 与渲染环境

Canvas/PDF按 `devicePixelRatio` 计算 backing size并设置上限；native Browser bounds使用 logical coordinates，不能把 physical pixel与 CSS rect混算。

RDP、VM、老 GPU或组策略可能让 WebView2进入 software rendering。Backdrop blur、合成动画和超长 Virtuoso会退化但不应崩溃。只有真实性能报告证明需要时，才在现有 theme/accessibility owner增加降级；不预先堆 feature detection。

## 发布验证

macOS CI或 Chromium browser test不能替代 Windows WebView2真机证据。影响上述边界的改动至少提供：

- pure/unit test锁定 URL、policy、geometry decision、fallback或schema；
- Windows debug build的 DevTools/CSP验证；
- release-like signed/bundled smoke验证实际 resource path和native child WebView；
- macOS回归，确认跨端修复没有改坏 WKWebView表现。

平台构建方式见 [`../guides/windows_build_guide.md`](../guides/windows_build_guide.md)，通用 Windows owner与进程/路径约束见 [`windows_platform.md`](windows_platform.md)。
