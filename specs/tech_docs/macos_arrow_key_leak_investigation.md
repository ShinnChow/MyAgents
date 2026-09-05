# macOS WKWebView 输入控制字符防护

macOS WKWebView 在部分键盘路径中可能把 NSFunctionKey 私有码点或其它不可见控制字符写进输入控件。该写入不一定经过标准 `beforeinput` / `input` 事件，也不一定调用 Cocoa `insertText:`，所以单层事件拦截不足以保护消息内容。

本文记录当前防护架构，不保留上游问题调查和已完成修复路线。

## 字符策略

`src/renderer/utils/macFunctionKeyGuard.ts` 与 `src-tauri/src/macos_arrow_filter.rs` 必须保持同一 policy：

- 拒绝 NSFunctionKey 私用区；
- 拒绝 C0、C1 和 DEL 控制字符；
- 保留正常文本需要的 Tab、LF 和 CR；
- 只删除明确禁止的 code point，不按可见字形或键名猜测。

两层分别实现时必须用 parity tests 锁住同一决策表。扩大过滤范围前先证明不会破坏 IME、粘贴、换行或无障碍输入。

## Renderer owner

`installMacFunctionKeyGuard()` 在入口调用，但 `shouldInstallMacFunctionKeyGuard()` 只允许 macOS 安装监听。Windows 和 Linux 不承担 DOM 扫描成本。

Renderer 防护包含：

1. `beforeinput`：对可识别的文本插入在 mutation 前阻止；
2. `input`：对已写入的 textarea/input 值立即清理；
3. `paste`：不读取剪贴板或阻止默认粘贴，而是在默认 mutation 后调度相同 scrub；
4. `keydown`：标准 input 事件缺失时，调度 generation-bounded scrub；
5. 输入值写入边界：使用原生 prototype setter，修正 selection，并覆盖 contenteditable / shadow-input 路径。

`keydown` scrub 使用有限的 microtask、animation frame 和 timer passes，覆盖 WKWebView 写入时序差异。新一代调度会使旧 generation 失效，不能让持续按键累积无界 timer。`preventDefault()` 不能作为方向键的通用解法，否则会破坏光标移动。

## Native owner

`src-tauri/src/macos_arrow_filter.rs` 在当前 Wry WebView Objective-C class 上安装防御：

- `insertText:`；
- `insertText:replacementRange:`。

当 native text object 是纯禁止字符时不向 super 转发；混合正常文本时不能整段吞掉。当前主要泄漏路径可能直接发生在 WebKit key handling 内部，因此 native filter 是前置保护，不替代 Renderer scrub。

Class 解析必须适应 Wry 生成 class 名称；找不到目标 class 时只报告诊断，不能对不相关 Cocoa class 做全局 swizzle。

## Lifecycle 与边界

- guard 每个 document lifetime 只安装一次；
- listener 和调度状态由安装模块拥有，不能散落到各输入组件；
- React state 不拥有脏字符修复；修复应尽量发生在 DOM / native 输入边界，之后再让正常 change path 同步；
- 日志只能记录 code point、控件类型和计数等诊断，不能记录用户输入内容；
- 此机制仅处理已知平台 defect，不是通用文本清洗器。Server、SessionStore 和消息渲染不应再复制过滤逻辑。

## 验证

确定性测试覆盖：

- 平台门控；
- C0/C1/DEL/NSFunctionKey 的删除与 Tab/LF/CR 保留；
- textarea/input/contenteditable；
- beforeinput、input、paste 触发的事后 scrub 和无标准 input 事件的 keydown scrub；
- selection clamp、native setter 与重复安装；
- 高频 key repeat 下 generation 有界、旧调度不回写；
- Rust 与 TypeScript policy parity。

macOS 真机 smoke 需覆盖方向键长按、Cmd/Ctrl 组合、中文 IME composition、复制粘贴、多行输入和多个 WebView。验证目标是输入值与发送内容都不含禁止字符，同时光标和 IME 行为不回退。
