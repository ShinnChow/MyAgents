# App Shell 交互规范

> **Status**: Active
>
> **Scope**: 全局侧栏、顶部 Tab、工作区与 Session 树、通知与 Shell 级弹层

本文描述用户可见的 App Shell 当前状态。Session、窗口呈现、搜索与 Theme 的技术 owner 分别见：

- [`../tech_docs/session_architecture.md`](../tech_docs/session_architecture.md)
- [`../tech_docs/chat_scroll_presentation_lifecycle.md`](../tech_docs/chat_scroll_presentation_lifecycle.md)
- [`../tech_docs/search_architecture.md`](../tech_docs/search_architecture.md)
- [`../tech_docs/theme_system.md`](../tech_docs/theme_system.md)

## 1. 信息架构

MyAgents 使用双层注意力导航：

- 全局侧栏回答“产品能力和资源在哪里”；
- 顶部 Tab 回答“哪些工作正在占用注意力”；
- 当前 Tab 内容只表达该资源内部状态，不建立第三套全局导航。

侧栏属于 App Shell，不属于 Launcher。所有主页面、Chat、Task Center、Skills & Tools、Settings 和 Record Detail 都由顶部 Tab 拥有；同类单实例页面重复打开时聚焦已有 Tab。

## 2. 布局与响应式

- 全局侧栏从窗口顶部延伸到底部；右侧才是 Tab chrome 和当前内容。
- 展开侧栏、rail、Header 和工作区面板尺寸统一消费 `src/renderer/index.css` 的结构 Token，不在组件复制像素。
- 手动收展时一次提交最终布局宽度，视觉层使用 clip/opacity/translate 完成 200ms 过渡；品牌图标和功能图标保持屏幕坐标稳定。
- 窄窗自动进入 rail；无法兑现的展开控制不显示。右侧工作区在空间不足时成为 Overlay，不挤压对话主栏。
- `prefers-reduced-motion` 下取消收展动画并立即切换最终状态。
- macOS 红绿灯和 Windows 窗口按钮使用原生控件与各自安全区，resize/fullscreen 期间不发生位置跳变。

## 3. 顶部 Tab

- Tab 保留 active、关闭、拖拽、溢出、生成中和未读语义；侧栏不复制 Tab 的“已打开”状态。
- active/hover 使用 `hover-bg`，active 增加 2px Accent 底线，不使用常驻阴影。
- 顶部“+”始终强制新建 Launcher；侧栏“新对话”优先聚焦最左侧已有 Launcher，不存在时再新建。
- Tab 标题和内容加载互相独立：点击资源后立即创建并激活目标 Tab，启动过程在目标内容内部反馈。失败撤销临时 Tab 并回到仍存在的前一 Tab；迟到结果不能抢回用户已经切走的 Tab。

## 4. 全局侧栏

展开态从上到下为：

1. 原生窗口 chrome 与固定收展控制；
2. App Icon 与 MyAgents 产品身份；
3. 新对话、搜索、任务、条件可用的团队、技能与工具；
4. Agent 工作区与 Session 树；
5. 通知、小助理和设置。

主导航与底部入口使用连续行，不用横线或逐组卡片切割。层级依靠组间留白、标题、缩进、文字权重和单一选中面表达。

rail 中：

- App Icon 与功能图标保持同一视觉轴；
- 工作区入口打开可交互 flyout，其他入口显示即时 `Tip`；
- flyout 覆盖主内容而不推动布局，资源树在稳定高度内独立滚动；
- hover/focus 离开真实交互区域后才关闭，展开树枝造成的边界变化不能误关；
- Escape 关闭并回到入口，菜单打开时不重复显示 Tooltip。

品牌行整体是官网链接，只使用 pointer 和键盘 Focus，不铺导航选中底色。

## 5. 工作区与 Session 树

- 工作区按置顶、最近打开、名称稳定排序；归档项进入默认收起分组。
- 默认工作区只在首次有效解析时种子展开一次；之后尊重用户跨重启保存的展开选择。
- 展开工作区首批显示 5 个 Session，“展开更多”每次增加 5 个；当前进程内折叠不重置数量。
- 工作区整行只切换树；新对话和更多菜单是独立动作。Session 整行打开或聚焦 Chat。
- 展开/收起使用 200ms 高度与透明度过渡，不逐条 stagger；Reduced Motion 下立即完成。
- 加载和失败按工作区隔离，使用同高静默占位或原位重试，不遮蔽其他树枝。
- 工作区和 Session 行不允许文本选中；右键只进入该资源的上下文菜单。
- 行内更多菜单绝对覆盖日期槽，不静态占用标题宽度。长标题只在真实截断并持续 hover 后显示完整 Tip。
- 资源树始终只有一个持久选中面：Launcher 选择工作区时选中工作区；Chat 已进入 Session 时只选中 Session，父工作区只提高字重。

Session 注意力信号：

- 运行中：success 脉冲点；
- 未读：Accent 静态点；
- 运行中优先于未读；
- 当前选中、后台已打开和普通历史不新增额外点状状态。

## 6. 行内动作和菜单

- 资源行的动作层只在 hover、focus-within 或菜单打开时显现，并用短渐变遮住实际重叠内容；隐藏时不截获鼠标。
- 工作区右侧低频“更多”在左，高频“新对话”在最右，收展和菜单状态不交换位置。
- 工作区菜单顺序为 Agent 设置、打开所在文件夹、置顶/取消置顶、归档、移除；危险动作收尾。
- Session 菜单第一项为复制对话 ID，格式为 `SessionID: <id>`；随后是收藏、统计和删除。搜索结果复用同一菜单。
- 任务导航行的快捷“+”只在展开态 hover/focus 出现，并阻止触发父级导航。

## 7. 通知、小助理与 Shell 弹层

- 通知 Bell 是常驻底部入口；未读只显示 6px Accent 圆点，不显示数字。
- 消息中心、rail 工作区 flyout 和小助理使用统一 elevated surface、圆角、阴影与 close-layer，但保留各自尺寸和内容结构。
- 消息中心为 fixed 非模态面板：Header 只保留“消息中心”和“全部已读”，正文独立滚动，加载/空态/局部失败不改变外壳尺寸。
- 通知项不显示来源图标或独立未读点；14px 标题、12px 摘要/时间，通过文字深浅表达已读。正文最多三行。
- 点击通知是唯一 read trigger，并继续执行目标导航。目标接纳后关闭；外链失败保留面板和复制 URL 的恢复入口。
- 外部点击、Escape、Cmd+W 关闭当前 Shell 弹层并恢复入口焦点；同层弹层互斥。

## 8. 搜索与右侧工作区

- 历史搜索点击后立即出现同尺寸面板壳；冷模块只替换内部内容，不重建 Backdrop 或重播入场动画。
- 搜索入口 hover/focus 可预取。空 query 是浏览全部历史并使用虚拟列表；非空 query 使用后端有界结果。
- 浏览态只保留“全部/收藏”和工作区筛选，来源用行内 Tag 表达。
- Chat 右侧工作区 Header 只展示身份、分支和路径，不显示易过期的文件聚合计数。
- 展开态最右侧依次为 Agent 设置和收起；隐藏后展开按钮占据同一最右槽位。面板与 Chat 之间使用局部短分隔，不使用通顶边框。
- Agent 能力初始收起，用户展开后才分配列表高度和渲染内容。

## 9. 全局产品 Tab

### 技能与工具

“技能与工具”是单实例 Tab，顶部使用“技能 / 插件 / 工具”三个下划线子 Tab，不使用胶囊分段器。页面标题使用 20px，描述使用 14px，内容最大宽度遵循现有 `max-w-4xl`。

页面只有一个外层主滚动；子 Tab 行到达顶部后才 sticky。技能、插件和工具列表不得各自建立与页面并列的主滚动区。旧 Settings deep link 统一重定向并聚焦该 Tab。

### Settings

Settings 是单实例 Tab，内部导航顺序为：模型供应商、通用设置、聊天机器人 Bot、桌面宠物、使用统计、网络代理、快捷键、关于。技能、插件和工具不在 Settings 重复出现。

- 网络代理是独立子页；供应商验证失败的“配置代理”直接进入该页。
- About 在联系方式后展示软件授权：AGPL-3.0-only 社区许可、闭源商业授权、许可证、源码、第三方声明和商业授权邮件均可达。
- “获取源代码”固定打开 GitHub 仓库默认页，不跟随当前版本、tag 或开发分支。
- Settings 与 Skills & Tools 分别保留自己的导航、草稿和弹层状态；app-global 配置 effect 由配置层持有，不随页面 mount。

## 10. 不变量

- App Shell 异步失败不能拖垮当前可用 Tab、导航或其他工作区。
- hover 动作、未读状态和菜单不能改变资源行的静态宽度。
- 同一导航动作只存在一套语义图标和一个 route owner。
- Shell 只投影 Session/Task/Notification authority，不从 DOM 或颜色反推业务状态。
