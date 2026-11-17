# Pigcode 基础控件尺寸

下表使用 CSS px。[ui-primitives 的 token](packages/ui-primitives/src/styles/tokens.css) 和组件档位定义控件的高度、圆角和内边距。调整界面字号、切换主题或聚焦时，外框尺寸保持一致。

## 单行表单

| 场景                                                | `Input` / 表单型下拉档位 | 高度 | 圆角 | 水平内边距 |
| --------------------------------------------------- | ------------------------ | ---: | ---: | ---------: |
| 常规表单、向导、项目名称和设备选择                  | `xl`                     |   36 |    8 |         12 |
| 右栏表单、带目录选择的单项安装弹窗                  | `lg`                     |   32 |    8 |         12 |
| 行内编辑、环境变量、模型 ID、重复规则中的数字和日期 | `md`（默认）             |   28 |    6 |          8 |
| 密集工具条里的数值编辑                              | `sm`                     |   24 |    6 |          8 |
| 色值等空间有限的行内编辑                            | `xs`                     |   20 |    4 |          8 |

同一表单里的普通单行字段用同一档，包含名称、ID、路径、参数和表单型下拉。标识符可以用 `mono` 字体，和普通文本框共用字号（默认 14 px）、内边距和外框。Agent 路径框用 36 px，旁边的 32 px 选择按钮垂直居中。一个紧凑行里的输入框及其提交或删除按钮用同一档，已有 Agent 实例的改名行用 32 px。

普通字段用 `Input`，表单型 `Select.Trigger` 用 `input select-trigger` 和相同的 `data-size`。公共下拉随容器收缩，较长的选中值通过 `grow truncate` 保留箭头空间。用 `.field` 排列标签、控件和说明，标签和说明各与输入框相隔 6 px。提示用 `.hint`，校验消息用 `.error-text`。无效字段设置 `aria-invalid` 并用 `aria-describedby` 关联错误提示，公共控件在悬停、聚焦时也显示错误描边。

业务样式可设容器宽度、换行和排列。单行控件默认填满容器。需要横向伸缩时，把 `flex: 1 1 auto` 和 `min-width: 0` 写在横排容器的直接子元素上。纵向分组保留组件的实际高度。

多行表单使用 `Textarea`，最小高度 64 px，按行数或编辑需要增高。默认圆角和内边距为 6 px 和 8 px。在 PR 等含有 32 或 36 px 单行字段的表单里，使用 `Textarea size="lg"`，使整组字段共用 12 px 横向内边距和 8 px 圆角。

聊天编辑器、文件编辑器、主题代码编辑区和定时任务的组合规则各有独立布局。浏览器地址栏（28 px）、视口数值框（24 px）、侧栏行内重命名和颜色卡片内的色值（20 px）可以按所在容器调整外观和内边距。定时任务和浏览器设备预设里的胶囊下拉用 24 px。

## 搜索框

| 场景                             | 档位      | 高度 | 外框圆角 |
| -------------------------------- | --------- | ---: | -------: |
| 插件市场等页面主搜索             | `xl`      |   36 |       12 |
| 设置、命令、模型、分支等弹层搜索 | `lg`      |   32 |        8 |
| 普通区域中的筛选                 | `default` |   28 |        6 |
| 文件树等密集侧栏                 | `compact` |   24 |        6 |

普通搜索用 `SearchField`。需要键盘选择候选项的搜索沿用 `Autocomplete`，把 `search-field` 和 `data-size` 放在输入组上。整个搜索框由输入组绘制，搜索图标用 `search-field-icon`，内层输入只负责文字录入。弹层里与列表连在一起的搜索行用 `plain` 外观。

搜索清除按钮的点击区独立于图标，常规和紧凑搜索为 20 × 20 px，页面主搜索为 24 × 24 px。设置侧栏的搜索入口是 28 px 按钮，点击打开 32 px 的搜索弹层，选中结果后跳到对应设置页。

插件市场标题行的操作按钮用 32 px，目录筛选标签用 28 px，主搜索用 36 px。搜索与筛选同排时宽度上限为 320 px。市场内容区宽度在 560 px 及以下时，搜索另起一行并填满可用宽度。

## 按钮和选择控件

| 场景                               | `Button` 档位    | 高度 | 图标按钮尺寸 |
| ---------------------------------- | ---------------- | ---: | -----------: |
| 工具栏、单项安装表单的选择目录     | `lg` / `icon-lg` |   32 |      32 × 32 |
| 普通动作、对话框页脚、设置搜索入口 | `md` / `icon`    |   28 |      28 × 28 |
| 密集列表、插件条目里的动作         | `sm` / `icon-sm` |   24 |      24 × 24 |
| 行尾小动作，以图标按钮为主         | `xs` / `icon-xs` |   20 |      20 × 20 |

24 px 文字按钮使用 `--fs-sm`（默认 12 px），20 px 档有文字时使用 `--fs-xs`（默认 11.5 px）。两档的行高均为字号的 1.25 倍，并跟随界面字号缩放。

`Switch` 默认 32 × 18，紧凑 `sm` 为 28 × 16。`Checkbox` 为 16 × 16，圆角 4。18 px 用于胶囊内动作和键帽，26 px 用于标题栏等专用控件。

## 源码与验收

ZCode 的规范将常规表单定为 36 px，紧凑表单与行内输入用 28 或 32 px。Pigcode 把 36 px 收进 `Input size="xl"`。页面搜索和弹层搜索沿用各自的尺寸。 [ZCode 尺寸规范][zcode-design] · [Input][zcode-input] · [SettingsSearchInput][zcode-page-search] · [设置弹层][zcode-setting-search] · [CommandInput][zcode-command] · [分支切换][zcode-branch]

修改控件时，在真实页面检查相邻控件、文字起点与点击区，也检查窄窗口、大字号、聚焦和校验状态。Electron 回归覆盖 Agent 向导和改名、字段报错、PR 表单、文件树清除搜索及英文大字号的窄窗口市场。

[zcode-design]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/DESIGN.md#sizing
[zcode-input]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/ui/src/components/ui/input.tsx
[zcode-page-search]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/ui/src/settings/SettingsSearchInput.tsx
[zcode-setting-search]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/ui/src/settings-search/SettingsSearch.tsx
[zcode-command]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/ui/src/components/ui/command.tsx
[zcode-branch]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/ui/src/GitBranchSwitcher.tsx
