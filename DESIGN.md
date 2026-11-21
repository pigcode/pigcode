# Pigcode 桌面界面尺寸标准

尺寸以 Cursor 3.31.15 为准：Agent 窗口（glass 模式）和 Cursor Settings。数值是从安装包里实测的，来源是 `out/vs/workbench/workbench.glass.main.js` 里的 `@anysphere/ui` 组件（StyleX 模块，表里写模块名，可以在文件里直接搜到）和 `workbench.glass.main.css`。经典编辑器的值只在 Agent 窗口没有对应物时才用。

所有尺寸都写在 [`tokens.css`](packages/ui-primitives/src/styles/tokens.css)，样式文件只引用 token。`scripts/style-check.ts` 的硬性规则保证颜色、圆角、字号和控件高度不在别处写死。下表都是默认字号下的 CSS px，界面字号设置会整体缩放字号和行高。

## 字号与行高

| 用途                                                     | 字号 / 行高 | 字重          | Cursor 出处                                          | Pigcode token                   |
| -------------------------------------------------------- | ----------- | ------------- | ---------------------------------------------------- | ------------------------------- |
| 计数、头像字母                                           | 10 / 12     | 400，计数 600 | `--cursor-font-size-2xs`，`CountBadge.tsx`           | `--fs-4xs` / `--lh-4xs`         |
| 行号、标签上的计数                                       | 11 / 14     | 400           | `--cursor-font-size-xs`                              | `--fs-2xs` / `--lh-2xs`         |
| 说明、分组标题、徽标、键帽、菜单里的说明                 | 12 / 16     | 400           | `--cursor-font-size-sm`，`section.tsx`、`kbd.tsx` md | `--fs-sm` / `--lh-sm`           |
| 界面默认：按钮、输入框、菜单、侧栏行、设置行的标题和说明 | 13 / 18     | 400           | `--cursor-font-size-base`，`Fieldset.tsx`            | `--fs-md` / `--lh-md`           |
| 弹窗标题                                                 | 15 / 24     | 500           | `Dialog.tsx` 标题（glass 模式下 lg 为 15/24）        | `--fs-heading` / `--lh-heading` |
| 页面标题                                                 | 17 / 21     | 500           | `settingsTabContainer.react.js` 的 h1                | `--fs-title` / `--lh-title`     |
| 新会话的问候                                             | 22 / 26     | 500           | `--cursor-font-size-3xl`（字距 −0.26px）             | `--fs-hero` / `--lh-hero`       |
| 会话正文、工具调用行                                     | 15 / 24     | 400           | `--cursor-font-size-transcript`                      | `--fs-content`（行高 1.6）      |
| 代码块                                                   | 12 / 18     | 400           | `DefaultCode.tsx`                                    | `--fs-code`                     |

字重只有三档：400 是默认；500 用在标题（页面、弹窗、卡片）和主按钮；600 只用在 Markdown 标题、头像字母和计数。界面正文的行高是 18/13 的比例，继承到 11 到 13 号字时接近 Cursor 的 14、16、18。

## 控件高度

圆角跟着高度走，这是 Cursor 组件库的默认值（`control-size.stylex.ts` 的高度配 `Sbe` 的圆角）。少数界面 Cursor 会显式改成胶囊，见下一节。

| 高度 | 圆角 |     左右内边距 | Pigcode 档位                                                        | 用在哪里                                                                           | Cursor 出处                                                                                 |
| ---: | ---: | -------------: | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
|   20 |    4 |              6 | `Button` sm / xs，`icon-sm` / `icon-xs`，`Input` sm / xs            | 设置行里的按钮、行尾小动作、工具条里的数值和色值                                   | `--cursor-height-sm`；Cursor Settings 的按钮都是 `size:"sm"`                                |
|   24 |    6 |  8（输入框 6） | `Button` 默认，`icon`，`Input` md，搜索框默认和 compact             | 默认按钮、图标按钮、顶栏按钮、右栏工具条里的下拉（工作树、Diff 的基准）            | `--cursor-height-md`，`Button` 与 `IconButton` 默认 md                                      |
|   28 |    8 | 10（输入框 8） | `Button` lg，`icon-lg`，`Input` 默认与 lg，`Select` 默认，搜索框 lg | 输入框和下拉的默认档（设置行、表单、弹窗）、页头和弹窗底栏的按钮、弹层搜索、侧栏行 | `--cursor-height-lg`；`Input.tsx`、`Select.tsx` 不写 size 时是 lg；`Dialog.tsx` 底栏强制 lg |
|   32 |    8 |              8 | `Input` xl，搜索框 xl                                               | 主输入框：任务的名字、项目的路径                                                   | `--cursor-height-xl`，`InputGroup.tsx`                                                      |
|   26 |    6 |              8 | 标签页                                                              | 右栏标签栏里的标签                                                                 | `TabSystem.stylex.ts`                                                                       |
|   18 |    3 |              4 | 键帽、计数徽标                                                      | 所有快捷键提示（命令面板、菜单、侧栏、模型列表）、计数；按钮里的快捷键只写淡色文字 | `kbd.tsx` md（底色 `bg-quaternary`），`CountBadge.tsx` md；按钮的 `kbs`                     |

按钮文字 13/18，图标和文字之间 6，主按钮 500 字重。按钮里的图标：20 与 24 高的文字按钮 12，28 高的 14（`Button.tsx` 的 `dxn` 映射）；24 与 28 高的图标按钮里是 14，20 高的是 12（xs 档 10）。同一排的确认与取消、文字按钮与图标按钮取同一档。

开关 32 × 20，滑块 16、离轨道 2；小号 26 × 16（`Switch.tsx` md / sm）。复选框 14、圆角 4、对勾 10（`Checkbox.tsx` md）。单选框 14，滑块轨道 6、拇指 14（`RadioGroup.tsx` / `Slider.tsx`）。分段控件外框 28，里面的项 24、圆角 6（`SegmentedControl.tsx` md）。多行输入框最小 64，是 Pigcode 自己的值（PR 说明这类表单），内边距和单行输入框相同。

普通字段用 `Input`，表单型 `Select.Trigger` 用 `input select-trigger` 和相同的 `data-size`。用 `.field` 排列标签、控件和说明，提示用 `.hint`，校验消息用 `.error-text`；无效字段设置 `aria-invalid` 并用 `aria-describedby` 关联错误提示。业务样式只设容器宽度、换行和排列，单行控件默认填满容器。输入框旁边的按钮和输入框取同一档高度。

## 胶囊与圆形

Cursor 的 Agent 窗口在几类界面里把控件显式改成两头全圆：`Button` 和 `IconButton` 传 `rounded`，或者外层用 `buttonRounded` 统一打开；`InputGroup` 和下拉触发器传 `shape="pill"`；还有 `Pill` 组件，它默认就是胶囊。Pigcode 在对应的界面照做。胶囊按钮的左右内边距比同一档的普通按钮多 2（20 高 8、24 高 10、28 高 12），图标和文字之间收到 4（`button-layout.stylex.ts` 的 `pill` / `pillSize`）；图标按钮仍是正方形，所以是正圆。

| 界面                                                       | 尺寸                                                                  | Cursor 出处                                                                                                                                                     | Pigcode                                     |
| ---------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 新会话输入框下方的建议                                     | 28 高、左右 10、13/18、图标 14，1px 描边，底色和输入框卡片相同        | 输入框上方的「Changes」「Create PRs」：`composer-pill.react.js` → `agent-header-pill.react.js` → `Pill` lg、outline                                             | `.pill.suggest-chip`                        |
| 筛选：插件市场的目录、插件管理的状态、定时任务的状态与页签 | 28 高、左右 10、13/18，1px 描边，胶囊之间 8；选中时铺底色、描边深一档 | 插件页的 Plugins / MCPs / Skills：`CustomizeManageView.tsx` 的 `Pill` lg、outline；选中 `bg-tertiary`、`stroke-primary`；`controlsScroll` 间距 8                | `.pill`，`SegmentedControl variant="pills"` |
| 插件页的搜索                                               | 28 高                                                                 | `CustomizeEngine.tsx` 的 `InputGroup shape="pill"`（默认 lg）                                                                                                   | `SearchField size="lg" shape="pill"`        |
| 页头的按钮（插件市场、插件管理、定时任务、任务编辑）       | 28 高、左右 12；图标按钮是 28 的正圆                                  | 插件页的「Manage」「Browse Marketplace」：`CustomizeEngine.tsx` 的 `Button` lg、`rounded`                                                                       | `Button shape="pill"`                       |
| 对话里审批、计划确认、提问卡片的按钮                       | 24 高、左右 10、13/18，靠右、间距 6                                   | `TranscriptCardFooter.tsx`：`buttonRounded`、`buttonSize:"md"`；`ToolApprovalGate`、`AgentTranscriptSwitchModeCard`、`AgentTranscriptMcpElicitationCard` 都用它 | `Button shape="pill"`，`.perm .acts`        |
| 输入框卡片里的加号和发送                                   | 24 的正圆，加号里的图标 14                                            | `PlusButtonTrigger.tsx`（`IconButton` md、`rounded`）、`PromptInputSubmitButton.tsx`（全圆、`--cursor-height-md`）                                              | `.composer-attach`，`.btn.send`             |
| 横幅里的按钮                                               | 档位不变，只换成胶囊                                                  | `BannerLayout.tsx`：`buttonRounded`（`Banner`、`TrayBanner`）                                                                                                   | 文件查看器的冲突提示                        |
| 提示条的关闭                                               | 20 的正圆                                                             | `ToastContent.tsx`：`IconButton` sm、`rounded`                                                                                                                  | `.toast-close`                              |

其余控件保持跟着高度的圆角，和 Cursor 一样：设置页的按钮、输入框和下拉（Cursor Settings 里没有一处传 `rounded` 或 `shape`），弹窗底栏和关闭按钮（`Dialog.tsx` 底栏只设 `buttonSize:"lg"`，关闭是 lg 的 ghost 图标按钮），表单，菜单，顶栏按钮（`--glass-chrome-control-radius` 取 `--cursor-radius-base`），以及设置页里卡片和行内的小按钮。

## 按钮的分工

同一种操作在每一页长得一样，看颜色就知道它是做什么的：

- **主按钮（墨黑）**：一个界面里最主要的一件事，只有一个，放在一排按钮的最右边。页头里就是这一页的「新建 / 添加」（定时任务的「新建任务」、插件市场和插件管理的「添加」），弹窗里是确认，审批卡片里是「允许一次」，PR 面板里是「创建 PR」。
- **次要按钮（白底细描边）**：其他要明确点一下的操作，比如页头的「插件管理」「检查更新」「立即运行」，行和卡片里的「安装」「更新」「打开」，设置行里的「检查」。
- **透明按钮**：工具和退出类的操作，平时只有图标或文字，悬停才有底色。页头的刷新、来源、更多（⋯）一律是透明的圆形图标按钮；弹窗的「取消」「返回」也是透明的。
- **危险按钮**：删除、完全访问这类不能撤回或风险高的确认，只出现在确认那一步。

列表行和卡片里的按钮：插件页是 20 高的白底胶囊，旁边的「⋯」是 24 的圆形；设置页按 Cursor Settings 用 20 高、圆角 4 的普通按钮。可以点的卡片（插件卡片、定时任务和模板）都是白底细描边，悬停时深一级（`--surface-hover`），键盘聚焦时描边换成焦点色。

## 行、菜单与浮层

| 组件                       | 尺寸                                                                                                    | Cursor 出处                                | Pigcode token / 样式               |
| -------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------- |
| 侧栏行、设置导航、列表行   | 最小高 28，左右 6，图标和文字之间 6，圆角 8，13/18；行与行之间 2                                        | `Sidebar.stylex.ts`                        | `--row-h`，`list-rows.css`         |
| 侧栏分组标题（项目、会话） | 最小高 30，13/18 常规字重灰字，分组之间 16                                                              | `SidebarGroupLabelRow.tsx`                 | `sidebar.css` 的 `.side-label`     |
| 文件树行                   | 24                                                                                                      | `file-tree-entry-view` 的 `rowHeightPx`    | `--row-h-compact`                  |
| 菜单项、下拉项             | 最小高 30，文字离外框 14，高亮离外框 6、圆角 8                                                          | `popup-list.stylex.ts`、`picker.stylex.ts` | `--menu-row-h`，`--menu-pad-x`     |
| 菜单外框                   | 圆角 14，四周内衬 6，最小宽 200；分隔线上下 6、左右离外框 14；分组标题 12/16                            | `popup-list.stylex.ts`                     | `menus.css`                        |
| 命令面板                   | 最宽 640，圆角 14，输入行左右 14；每项最小 32、内边距 6 × 8、圆角 8、图标和文字之间 10；分组标题最小 28 | `Palette.tsx`                              | `--palette-row-h`，`palette.css`   |
| 浮层、下拉弹层             | 圆角 12，13/18                                                                                          | `floating-surface.stylex.ts`               | `.popup`                           |
| 提示气泡                   | 13/18，内边距 6 × 10，圆角 8                                                                            | `floating-surface.stylex.ts` 的 tooltip    | `.tip-popup`                       |
| 设置卡片里的设置行         | 内边距 12，文字和控件之间 20，单行 42 高；行间细线左右各收进 12                                         | `Fieldset.tsx`                             | `--row-h-lg`，`.group > .list-row` |
| 设置行里的控件             | 输入框和下拉最宽 160                                                                                    | `Fieldset.tsx` 控件区 `10rem`              | `--agent-control-w`                |

## 弹窗

宽度五档：sm 320、默认 400、lg 480、xl 560、2xl 640，距窗口边缘至少 16（`Dialog.tsx`）。圆角 12。头部内边距 16，标题 15/24、500 字重，关闭按钮 28 高、和标题那一行竖直居中。正文紧接头部，左右下 16，项与项之间 16，文字 13/18。底栏内边距 16，按钮之间 8，上面一条细线，按钮 28 高。

| 弹窗                                           | 宽度     |
| ---------------------------------------------- | -------- |
| 确认、删除这类小弹窗                           | 默认 400 |
| 添加项目、插件详情、自定义重复                 | lg 480   |
| 安装插件、添加插件市场、插件市场列表、设置搜索 | xl 560   |
| 添加 Agent 向导、命令面板                      | 2xl 640  |

## 栏高

| 栏                               |       高度 | Cursor 出处                               | Pigcode token                              |
| -------------------------------- | ---------: | ----------------------------------------- | ------------------------------------------ |
| 侧栏顶行、对话头、右栏标签栏     |         40 | `--glass-chrome-bar-height`               | `--topbar-h`、`--bar-h`                    |
| 顶栏里的按钮                     | 24，圆角 6 | `--glass-chrome-control-size`             | `.panel-top .btn-icon`、`.window-controls` |
| 右栏文件查看器与终端抽屉的标题行 |         40 | 和顶栏统一（Cursor 的面板都用这一个栏高） | `--panel-head-h`                           |
| 侧栏底部的账户行                 |         40 | 参照顶栏                                  | `--side-foot-h`                            |

## 圆角

| 圆角 | 用在哪里                                                                | Cursor 出处                                         | Pigcode token  |
| ---: | ----------------------------------------------------------------------- | --------------------------------------------------- | -------------- |
|    2 | 细条、滑块轨道                                                          | `--cursor-radius-xs`                                | `--r-2xs`      |
|    3 | 键帽                                                                    | `kbd.tsx`                                           | `--r-kbd`      |
|    4 | 复选框、20 高的按钮、徽标                                               | `--cursor-radius-sm`                                | `--r-xs`       |
|    6 | 24 高的按钮和输入框、标签页、弹窗列表行                                 | `--cursor-radius-base`                              | `--r-sm`       |
|    8 | 28 与 32 高的控件、侧栏行、菜单项高亮、命令面板项、提示气泡、卡片里的块 | `--cursor-radius-lg`                                | `--r-block`    |
|   12 | 卡片、弹窗、浮层、代码块、用户消息                                      | `--cursor-radius-xl`                                | `--r-panel`    |
|   14 | 菜单与命令面板的外框                                                    | `--cursor-radius-2xl`                               | `--r-xl`       |
|   20 | 对话输入框                                                              | `PromptInput.tsx` 的 `--prompt-input-border-radius` | `--r-composer` |
| 全圆 | 胶囊与圆形（见上面「胶囊与圆形」），开关、头像、状态点                  | `--cursor-radius-full`                              | `--r-full`     |

## 间距

间距刻度是 2、4、6、8、10、12、16、20、24（`--space-1` 到 `--space-9`），都在 Cursor 的 `--cursor-spacing-*` 里。另有几个固定用途的间距：菜单与命令面板行的左右内边距 14（`--menu-pad-x`），页面左右边距 28、上下 48（`--page-pad-x` / `--page-pad-y`），分组之间 28（`--section-gap`），都取自 Cursor Settings（`glass-settings-panel` / `settingsTabContainer`）。

## 图标

图标四档：10、12、14、16（`.ui-icon` 的 xs / sm / base / lg），对应 `--icon-xs` 到 `--icon-lg`，描边 1.5（Cursor 内联 SVG 最常用的 `strokeWidth`）。侧栏行和菜单项的图标 14；对话区的图标跟对话字号走，15；顶栏按钮和应用图标 16。头像 16、24、32（`avatar.tsx` sm / lg / xxl），Agent 品牌图标 12、14、16、20、24。

## 版心与布局

- 所有页面（设置、插件、定时任务和它们的子页面）共用一个版心：内容最宽 680（Cursor Settings 的 `max-width: 42.5rem`），左右各 28、上下 48 的页边距（`--col-page`）。
- 页头：标题 17/21，下面一行 13/18 的说明，左右各收进 8，头部到内容 20。子页面在标题上方放「‹ 上一页」的返回链接（`PageCrumbs`）。按钮是 28 高的胶囊；有新建或添加的页面，页头恰好一个主按钮，放在最右（见「按钮的分工」）。
- 分组标题 12/16、常规字重的灰字，左边收进 8，到卡片 8；分组之间 28（`section.tsx`）。插件市场的分类、插件管理的分组和定时任务的分组也用这一种。
- 两列卡片（插件市场、定时任务）在内容宽 600 以下换成一列，卡片圆角 12、内边距 12（Cursor 插件市场的卡片）。
- 会话列最宽 780，左右各 16（`agent-panel-constants.js`）；侧栏默认 260（`constants.js`）。

## Cursor 没有对应物的组件

| Pigcode 组件                    | 参照的 Cursor 组件               | 取值                                                       |
| ------------------------------- | -------------------------------- | ---------------------------------------------------------- |
| 插件卡片、定时任务卡片和模板    | 插件市场卡片和 Settings 分区卡片 | 圆角 12，内边距 12，标题 13/18、500，说明 12/16            |
| 插件与 Agent 的字母头像         | 头像（`avatar.tsx`）             | 列表里 32，插件详情 35（Cursor 插件详情的 logo），中性底色 |
| Agent 页左边的列表              | `DialogList.tsx` 的多行行        | 最小高 48，图标盒 20                                       |
| Agent 品牌底座                  | 头像 xxl                         | 32                                                         |
| 新会话的问候                    | `--cursor-font-size-3xl`         | 22/26，500                                                 |
| 模型菜单                        | 菜单和下拉弹层                   | 外框圆角 14、行 30、最高 360；左栏按钮用 32 的图标按钮     |
| 输入框卡片的紧凑一行            | `PromptInput.tsx` 与提交按钮     | 圆角 20，按钮 24，正文 15/24，卡片内衬 8                   |
| 新会话里加高的输入区            | 无                               | 正文区最小 70，Pigcode 自己的值                            |
| 命令面板与子 agent 标题的图标盒 | 侧栏的图标盒                     | 20                                                         |

## 动效

时长只有四档（Cursor 的 `--cursor-duration-*`）：100 用于悬停、按下和开关（`--t-fast`），150 用于菜单和浮层（`--t-med`），200 用于展开和进场（`--t-slow`），300 用于高度变化（`--t-slower`）。曲线统一用 `--ease`，只动颜色、底色、描边、透明度和 transform。

- 按下：按钮、图标按钮和胶囊缩到 0.98（`--press-scale`，Cursor `press.stylex.ts` 的 `--ui-press-scale`）。
- 浮层：菜单、下拉、悬浮提示和弹窗从触发它的那一侧淡入，并从 0.97 放大（`--enter-scale`），收起用 100（Cursor 浮层的 `data-starting-style`）。
- 页面：设置、插件、定时任务这些页面打开时淡入并上移 4（`--enter-rise`），新会话的问候（连同后面的标志）用 300。
- 一直在动的只留给真的在进行中的东西：运行中的点阵、工具调用行的流光、Agent 正在操作浏览器的提示。
- 居中的弹窗和按钮用独立的 `translate` 定位，进出场和按下只改 `transform`，两者不会互相覆盖。
- 系统打开「减少动态效果」时，动画和过渡全部关掉；外观设置可以单独打开。

## 和 Cursor 不同、有意保留的地方

- 细线用 0.5px（`--hair`），Cursor 是 1px。Pigcode 的描边颜色是按 0.5px 调的，直接改成 1px 会比 Cursor 重一倍；要换成 1px，需要同时把描边颜色调淡。
- 右栏默认宽 460（`--right-w`）。Cursor 的右侧面板默认占一半宽度、最小 384，Pigcode 还没有改成按比例。
- 输入框卡片在只有一行时把按钮和正文排在同一行，这是 Pigcode 的排法；部件尺寸照 Cursor。
- 所有页头的按钮都用插件页页头的胶囊。Cursor 的自动化列表页（对应定时任务）页头是 24 高的普通按钮（`AutomationsListPage.tsx` 的「New Automation」），Pigcode 的页头是同一个组件，统一取插件页的样子。

## 验收

修改控件时，在真实页面检查相邻控件、文字起点与点击区，也检查窄窗口、大字号、聚焦和校验状态。点击区至少 24 × 24，密集行可以扩大热区或由整行响应。会话中的动作名、命令、文件名和运行结果在默认深浅主题中与所在表面的对比度至少为 4.5∶1，失败保留文字说明并使用错误文字色。视觉回归会检查页头和弹窗底栏的按钮都是 28 高。[文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)
