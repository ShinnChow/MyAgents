# Launcher 与 Composer 交互规范

> **Status**: Active
>
> **Scope**: Launcher、“对话/记录”模式、共享 AI 输入框与运行配置菜单

技术边界见 [`../tech_docs/session_architecture.md`](../tech_docs/session_architecture.md)、[`../tech_docs/multi_agent_runtime.md`](../tech_docs/multi_agent_runtime.md) 和 [`../tech_docs/theme_system.md`](../tech_docs/theme_system.md)。

## 1. Launcher 职责

Launcher 只负责创建新工作：

- Theme 提供的品牌 Hero；
- Chat / Record 模式；
- 工作区、模型、Runtime、权限和推理强度；
- 文件、Skill、插件、工具、定时等发送前配置；
- 最近 Record 的轻量直达。

Launcher 不展示工作区管理卡片、完整历史列表、全局搜索、dev Logs 或 Settings 功能。资源浏览与管理属于全局侧栏。

选择工作区只在全局树上投影关联高亮，不展开树，也不提前启动对话；真正提交后才进入新的工作。

## 2. 品牌区域

产品名、slogan、字体、渐变和可选背景全部来自 `ResolvedTheme.hero`。Launcher 不硬编码品牌文案或背景资源；Settings About 和全局侧栏复用产品字标基类，但使用各自尺寸角色。

品牌区在窄窗降低展示字号并收紧留白，不隐藏产品主身份或挤压输入主动作。

## 3. “对话”与“记录”模式

- 两种模式共用同一输入主区域、外框高度和模式切换位置，切换不能造成输入卡跳动。
- Chat 提交启动或继续 AI Session。
- Record 文字提交创建 text Record；“开始录音”创建 audio Record 并立即打开 Record Detail Tab。
- Record 模式下最近内容可以轻量直达；完整筛选和管理进入 Task Center。
- 模式切换不改变全局侧栏、顶部 Tab 或当前工作区选择。

## 4. Composer 结构

Composer 从上到下为：

1. 可选草稿/上下文横条；
2. 多行正文输入；
3. 左侧添加与上下文动作；
4. 右侧模式/模型和主提交动作。

正文使用 16px / 26px 行高，初始几何在 Launcher 和 Chat 保持一致。输入自增长到上限后内部滚动，不持续推走消息或最近内容。

工具栏新增动作不得撑高外框；文字动作与图标动作在视觉上共享同一基线和命中高度。

## 5. 添加菜单和选择器

- `+` 菜单收纳引用文件、Skill、上传和定时任务等低频创建动作。
- `@` 文件引用与 `/` Skill 菜单使用共享浮层层级和 `shadow-md`。
- 菜单使用 200ms opacity + 纵向 translate 入场，不用 scale 覆盖 Floating UI 的定位 transform。
- 当前模型菜单拥有独立滚动区；打开首帧将当前模型放入可视范围，异步刷新后再次校正，不调用会牵动页面的全局 `scrollIntoView`。
- “管理自定义模型服务”只在 AgentSDK 输入 chrome 显示；点击关闭菜单并打开或聚焦 Settings 的模型供应商页面。

## 6. Runtime 与权限模式

菜单展示真实 Runtime 能力，不根据输入框长相猜测：

- builtin Claude Agent SDK 可展示自身系统指令；
- Managed Codex 只额外展示已原生支持的 `/compact`；
- 用户自管 Claude Code/Codex/Gemini 不展示未适配的 SDK 系统指令。

权限图标使用统一语义：只读规划、逐项确认、自动编辑、受约束自主执行、跳过审批分别使用对应的 Eye、ShieldQuestion、FilePenLine、ShieldCheck、LockOpen 词汇。未知自定义模式保留 Runtime 自己声明的图标和文案。

`/compact` 与 context 卡片中的“智能压缩”复用同一个 Session 控制动作和状态，不生成对话消息。

## 7. Goal 草稿

Chat 中选择 `/goal` 后立即在输入框上方显示 Goal 草稿横条；正文继续在主输入框填写并随首次发送启动。横条只保留设置和取消，结束条件、通知等低频参数进入二级设置，不先弹完整表单阻断输入。

## 8. 提交与失败

- 空输入不提交，IME composing 期间 Enter 不误触发送。
- 可连续录入的场景提交成功后保持输入焦点。
- 提交失败保留正文、附件、工作区和配置，错误在当前输入区域反馈并提供重试。
- 启动新 Session 或 Record 时先给出 Tab/页面反馈，不让用户停留在无变化的旧页面等待后台完成。
- 当前表面已经出现结果时不重复 Toast；跨 Tab 或系统级结果才使用全局反馈。
