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

同一表单里的普通单行字段用同一档，包含名称、ID、路径、参数和表单型下拉。标识符可以用 `mono` 字体，和普通文本框共用字号（默认 14 px）、内边距和外框。Agent 路径框用 36 px，旁边的 32 px 选择按钮垂直居中。一个紧凑行里的输入框及其提交或删除按钮用同一档。

普通字段用 `Input`，表单型 `Select.Trigger` 用 `input select-trigger` 和相同的 `data-size`。用 `.field` 排列标签、控件和说明，标签和说明各与输入框相隔 6 px。提示用 `.hint`，校验消息用 `.error-text`，以 `aria-describedby` 关联。

业务样式可设容器宽度、换行和排列。单行控件默认填满容器。需要横向伸缩时，把 `flex: 1 1 auto` 和 `min-width: 0` 写在横排容器的直接子元素上。纵向分组保留组件的实际高度。

多行表单使用 `Textarea`，最小高度 64 px、圆角 6 px、内边距 8 px，根据行数或编辑需要增高。聊天编辑器、文件编辑器、主题代码编辑区和定时任务的组合规则各有独立布局。浏览器地址栏（28 px）、视口数值框（24 px）、侧栏行内重命名和颜色卡片内的色值（20 px）可以按所在容器调整外观和内边距。定时任务和浏览器设备预设里的胶囊下拉用 24 px。

## 搜索框

| 场景                             | 档位      | 高度 | 外框圆角 |
| -------------------------------- | --------- | ---: | -------: |
| 插件市场等页面主搜索             | `xl`      |   36 |       12 |
| 设置、命令、模型、分支等弹层搜索 | `lg`      |   32 |        8 |
| 普通区域中的筛选                 | `default` |   28 |        6 |
| 文件树等密集侧栏                 | `compact` |   24 |        6 |

普通搜索用 `SearchField`。需要键盘选择候选项的搜索沿用 `Autocomplete`，把 `search-field` 和 `data-size` 放在输入组上。整个搜索框由输入组绘制，搜索图标用 `search-field-icon`，内层输入只负责文字录入。弹层里与列表连在一起的搜索行用 `plain` 外观。

设置侧栏的搜索入口是 28 px 按钮，点击打开 32 px 的搜索弹层，选中结果后跳到对应设置页。插件市场顶栏操作用 32 px 按钮，主搜索用 36 px。

## 按钮和选择控件

| 场景                               | `Button` 档位    | 高度 | 图标按钮尺寸 |
| ---------------------------------- | ---------------- | ---: | -----------: |
| 工具栏、单项安装表单的选择目录     | `lg` / `icon-lg` |   32 |      32 × 32 |
| 普通动作、对话框页脚、设置搜索入口 | `md` / `icon`    |   28 |      28 × 28 |
| 密集列表、插件条目里的动作         | `sm` / `icon-sm` |   24 |      24 × 24 |
| 行尾小动作                         | `xs` / `icon-xs` |   20 |      20 × 20 |

`Switch` 默认 32 × 18，紧凑 `sm` 为 28 × 16。`Checkbox` 为 16 × 16，圆角 4。18 px 用于胶囊内动作和键帽，26 px 用于标题栏等专用控件。

## 源码与验收

ZCode 的规范将常规表单定为 36 px，紧凑表单与行内输入用 28 或 32 px。Pigcode 把 36 px 收进 `Input size="xl"`。页面搜索和弹层搜索沿用各自的尺寸。 [ZCode 尺寸规范][zcode-design] · [Input][zcode-input] · [SettingsSearchInput][zcode-page-search] · [设置弹层][zcode-setting-search] · [CommandInput][zcode-command] · [分支切换][zcode-branch]

修改控件时，在真实页面检查相邻控件，包括聚焦、校验消息出现和窗口变窄时的实际外框。Electron E2E 对 Agent 向导名称和 ID 的高度、圆角、字号与内边距作断言。视觉回归和英文文案检查共用产品操作路径，覆盖 Agent 向导、插件市场、设置搜索和右栏表单。

[zcode-design]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/DESIGN.md#sizing
[zcode-input]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/ui/src/components/ui/input.tsx
[zcode-page-search]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/ui/src/settings/SettingsSearchInput.tsx
[zcode-setting-search]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/ui/src/settings-search/SettingsSearch.tsx
[zcode-command]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/ui/src/components/ui/command.tsx
[zcode-branch]: https://github.com/zai-org/ZCode/blob/fec975905a2abd4c07e35c40d51fa097a2258ec9/packages/ui/src/GitBranchSwitcher.tsx
