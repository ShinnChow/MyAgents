# UI Internationalization Architecture

本文档描述 MyAgents 产品界面国际化框架。它只覆盖产品 UI 文案与 native chrome（托盘菜单等）；AI 输出内容、用户工作区文件内容、日志原文不在本框架内翻译。

## 核心模型

语言选择分两层：

| 概念 | 含义 | Owner |
|------|------|-------|
| `UiLanguage` | 用户配置值：`system` 或显式 locale | `AppConfig.uiLanguage` |
| `SupportedLocale` | 实际渲染 locale | `src/shared/i18n.ts` + `src-tauri/src/i18n.rs` |

`UiLanguage` 是持久化字段，写在 `~/.myagents/config.json::uiLanguage`。新安装默认 `system`；老配置缺少该字段时迁移为 `zh-CN`，避免存量用户升级后界面语言突然变化。

支持的 locale 必须显式 allow-list。新增语言不能只添加 JSON 文件，还必须同步 TypeScript shared 定义、Rust native 定义、Settings 选项、格式化逻辑与测试。

## 文件分工

| 文件 | 职责 |
|------|------|
| `src/shared/i18n.ts` | 前后端共享的 locale allow-list、normalize、fallback 规则 |
| `src/shared/config-types.ts` | `AppConfig.uiLanguage` 类型与默认值 |
| `src/renderer/i18n/index.ts` | i18next 初始化、namespace 与资源注册 |
| `src/renderer/i18n/locales/<locale>/*.json` | Renderer 文案资源 |
| `src/renderer/i18n/I18nLanguageSync.tsx` | 主窗口语言同步 |
| `src/renderer/i18n/FloatingI18nBootstrap.tsx` | 浮球 / 伴随窗口语言 bootstrap |
| `src/renderer/i18n/format.ts` | 日期、相对时间等 locale-aware formatter |
| `src-tauri/src/i18n.rs` | Native UI 语言状态、system locale、托盘文案、Tauri commands |
| `src-tauri/src/tray.rs` | 托盘菜单 handle 保存与 relabel |

Renderer 文案按 namespace 分组，目前包括 `common`、`app`、`settings`、`chat`、`launcher`、`task`。统一 Record 列表、Record detail、录音/转录与 Speech 资源卡当前复用 `task` namespace；托盘“正在录音...”属于 native 文案，位于 Rust locale table。新页面应优先复用既有 namespace；当页面形成独立产品面时再新增 namespace。

## 同步链路

### 主窗口

主窗口有完整 `ConfigProvider`。用户在 Settings 里修改语言时调用 `updateConfig({ uiLanguage })`：

1. Tauri 环境下 `ConfigProvider` 调 `cmd_set_ui_language`。
2. Rust 侧持有 `UI_LANGUAGE_MIRROR_LOCK`，先用 `with_config_lock` 写盘。
3. 写盘成功后更新托盘菜单，并 emit `ui-language-changed`。
4. `I18nLanguageSync` 收到事件后切换 i18next language。
5. `ConfigProvider` 重新读盘同步 React config mirror。

写盘失败必须 fail closed：不更新托盘、不广播成功、不让 Settings 显示成功。

### 浮球与伴随窗口

浮球窗口没有完整 `ConfigProvider`，不能依赖主窗口 React 状态。`FloatingI18nBootstrap` 启动时直接读取 native 语言状态，并等待语言准备完成后再渲染子树，避免第一帧闪成错误语言。后续同样监听 `ui-language-changed`。

### Admin CLI / 外部配置写入

当 Admin CLI 或其它配置写入路径改变 `uiLanguage`，主窗口刷新配置后会调用 `cmd_sync_ui_language_from_config`，让 Rust 重新读盘、更新托盘并广播语言事件。不要只更新 React config mirror，否则 native UI 会停留在旧语言。

## System Locale

`system` 表示跟随系统语言，不是固定英文。Tauri 环境下 native locale 是主源：Rust 使用 `sys-locale` 获取平台 UI locale，并带环境变量 fallback。Renderer 在 Tauri 内读取 `cmd_get_ui_language_state` 的结果；只有浏览器开发环境才用 `navigator.languages` 作为 fallback。

不要在新的 renderer 代码里重新实现一套 system-locale 解析，否则主窗口、浮窗、托盘会出现 split-brain。

## 增加新语言

以新增 `ja-JP` 为例，必须完成：

1. `src/shared/i18n.ts`：加入 `SUPPORTED_LOCALES`、类型测试、normalize 测试。
2. `src/renderer/i18n/locales/ja-JP/*.json`：补齐所有 namespace，key 集合必须与 fallback locale 对齐。
3. `src/renderer/i18n/index.ts`：import 并注册 `ja-JP` 资源。
4. Settings 语言选择：加入显示名，例如 `common.language.jaJP`。
5. `src-tauri/src/i18n.rs`：加入 Rust enum、serde rename、system locale resolve、托盘文案表与测试。
6. Formatter：检查 `src/renderer/i18n/format.ts`、cron humanizer、任务中心时间文案是否需要语言分支或 `Intl` locale。
7. Tests：至少覆盖 shared normalize、配置迁移、一个 renderer 文案渲染、Rust locale resolve。

只添加 JSON 资源不完整，因为 native tray 与 persisted config allow-list 不会自动接受新 locale。

## 开发约束

- 新增用户可见 UI 文案时，优先走 `useTranslation()` 与 locale JSON；不要把可复用产品文案继续硬编码在组件里。
- 仍在迁移中的旧页面可以逐步抽取，但已经接入 i18n 的 surface 不应回退到硬编码中文。
- Native 文案数量要保持很少，只覆盖不能由 React 渲染的 chrome；普通产品界面文案归 renderer JSON。
- Record/Recording/Speech 新文案必须保持 zh-CN/en-US key parity；状态码、CLI error code、job stage 与 analytics 枚举是稳定协议值，不做翻译，Renderer 只把它们映射为 locale 文案。
- `AppConfig.uiLanguage` 在 Tauri 环境必须通过 `ConfigProvider.updateConfig` / `cmd_set_ui_language` 修改，不要绕过 native owner 直接写盘。
- 格式化函数必须显式接收 locale 或从 i18next 当前语言派生；公共工具函数为了兼容旧调用可默认 `zh-CN`，但新调用应传入当前 locale。
