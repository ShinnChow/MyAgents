# Task Center 交互规范

> **Status**: Active
>
> **Scope**: Task Center、Task 创建、列表、详情、评论与 Record 汇总入口

Task 状态、调度、Session、Store 与评论投送的权威规则见 [`../tech_docs/task_center.md`](../tech_docs/task_center.md)。本文只描述用户可见交互。

## 1. 页面结构

Task Center 是单实例 Tab。宽窗分为：

- 左侧“想法”：text/audio Record 输入、筛选和列表；
- 右侧“任务”：按生命周期分组的 Task 列表与创建入口。

左栏以 480px 为基准且不超过页面可用宽度，右栏占据剩余空间；两栏内部都必须 `min-width: 0`，不允许 Record 虚拟列表或 Task 行溢出边界。

左侧输入标题为“想法”，Placeholder 为“记录此刻的想法…用 #标签 归类”。提交按钮左侧提供“开始录音”，从这里创建新的 Record Detail Tab，Task Center 保留不变。

Record 卡片的完整行为见 [`records_and_recording.md`](records_and_recording.md)。

## 2. Task 创建入口

侧栏、Task Center 和 Record 派发复用 App Shell 唯一创建面板：

- 侧栏和 Task Center 默认进入“智能”；
- text Record 派发默认进入“手动”；
- 关闭面板后不记忆上次 Tab；
- Header 只显示“新建任务”和“智能/手动”，不重复解释流程。

Tab 支持左右键、Home/End 和 roving focus。

## 3. 智能创建

智能 Tab 只保留：

- Agent 工作区选择；
- 一个完整目标输入框；
- 主动作“与 AI 讨论”。

点击后进入新的 AI discussion Session，确认前不创建 Task。启动失败保留工作区和原输入。

## 4. 手动创建与编辑

手动创建和编辑只维护一份 canonical `task.md`，不提供平行的简短描述、标签或独立验收输入。

字段按以下认知顺序组织：

1. 名称与完整任务内容；
2. 工作区与 Agent 工作区；
3. 执行时机和通知；
4. 高级配置。

会话策略、触发前检测和结束条件只在周期任务出现。立即执行和定时一次不展示、不提交周期专属隐藏值。编辑 sheet 与创建表单复用同一字段、显隐和校验规则。

Command Task 将 test、check-now、run-now、reset 表达为四个不同动作，不用一个模糊“运行”按钮混合语义。

## 5. Task 列表

列表按固定顺序分组：

1. 进行中：running / verifying；
2. 待恢复：stopped / blocked；
3. 已完成：done / archived；
4. 规划中：todo。

分组只投影状态，不修改状态。行内不重复生命周期 Tag，只保留执行类型等仍有区分价值的信息；精确状态进入详情 Header。

列表模式的已完成项默认显示最近 10 条，“加载更多”每次增加 10 条；搜索时不隐藏匹配项。卡片模式不分页。

Task 行整体承担打开详情的主动作并支持 Enter/Space。内部菜单和 Session 入口保持独立。日期槽在 hover/focus 时原位替换为“会话详情”，隐藏动作不参与静态宽度计算。

## 6. Task Detail

详情是可路由、全高的大 Drawer，不复用创建表单外壳。

Header 保持单行，只放：

- 精确状态；
- 单行截断标题；
- 一个生命周期主动作；
- 更多菜单；
- 关闭。

编辑位于更多菜单，打开 Drawer 内第二层 sheet；有未保存修改时关闭需要确认。

### 主栏

- 阅读完整 `task.md`，正文前只显示折叠 home 的路径，不重复“task.md/执行 Prompt”标题。
- Markdown、代码和表格必须收敛在主栏；代码块和表格自己横向滚动。
- 下方按时间正序显示评论，底部是默认两行、有限增长后内部滚动的吸底 Composer。
- Comment 使用 compact Markdown；主身份为 14px，时间与 Session ID 为 12px。
- 已加载父评论的回复引用占满单行后省略，使用弱底色和左侧结构线；只有 Agent 身份行可以进入 Session。

### 属性栏

宽窗使用约 360–400px 的扁平属性栏，展示状态、调度/触发、工作区、Runtime、Session 和通知。摘要不再包第二层 Card。

执行记录默认 5 条，以整行“展开更多 + 行尾箭头”每次增加 5 条。空间不足时属性栏变为独立 Sheet。

完整 status history、`progress.md` 和独立 legacy `verify.md` 不在详情展示。

## 7. 评论与通知

- 评论提交后立即出现在时间线；当前表面已经反馈时不重复 Toast。
- 发送失败保留草稿与回复关系，允许原位重试。
- Bell、OS 通知、Task 列表和 typed deep link 都打开同一个详情 Drawer。
- Comment deep link 必须定位、Focus 并短暂高亮 exact Comment，同时向读屏器播报。
- 即使 Task Center 已经是当前 Tab，新 route 仍必须重新投送，不能因“页面已打开”而吞掉导航。

## 8. 删除与归档

归档是可恢复生命周期动作；删除是产品层不可恢复动作。删除确认必须展示 exact Task 和后果，危险动作位于菜单尾部。Record 与 Task 各自独立删除，删除源 Record 不级联删除已经派发的 Task。
