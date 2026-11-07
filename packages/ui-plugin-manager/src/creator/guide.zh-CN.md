## Pigcode 插件创建指南

按下面的规范，在当前项目里写一个 Pigcode 插件，写完告诉我怎样在 Pigcode 里添加和安装它。

### 1. 先弄清楚要做什么

需求不够具体时先问我：插件做什么，出现在哪里（左侧栏的面板、右侧面板的标签页、设置页、命令面板与输入框 `/` 的命令、给 agent 用的 MCP 工具、时间线里某个工具调用的显示）。

### 2. 目录结构

- 插件放在 `plugins/<slug>/`，slug 用小写字母、数字和连字符。插件市场的目录文件放在 `plugins/.pigcode-plugin/marketplace.json`。
- 用纯 JavaScript（ES module，`.js`）：不要 TypeScript、JSX，不要构建步骤，也不要第三方依赖。Pigcode 安装后直接加载这些文件。

```text
plugins/
├── .pigcode-plugin/marketplace.json
└── <slug>/
    ├── package.json
    ├── host.js      # Host 入口：MCP 工具、服务（可选）
    └── client.js    # 界面入口：面板、标签页、设置页、命令（可选）
```

### 3. package.json

```json
{
  "name": "pigcode-<slug>",
  "version": "0.1.0",
  "description": "一句话说明",
  "type": "module",
  "license": "MIT",
  "pigcode": {
    "apiVersion": 1,
    "kind": "capability",
    "displayName": "显示名",
    "host": "./host.js",
    "client": "./client.js",
    "inject": ["mcp"],
    "permissions": []
  }
}
```

- `kind`：只有界面时用 `ui`，只写 `client`；有 Host 入口时用 `capability`。接入新的 agent CLI（`agent`）比较复杂，这里不做。
- `host` 和 `client` 至少要有一个，指向的文件必须存在。`name` 全小写，它就是插件的包名。
- `inject` 写 Host 入口要用的服务：MCP 工具是 `mcp`，读线程事件是 `sessions`。

### 4. Host 入口（host.js）

在 Pigcode 的 Host 进程里运行，可以用 Node 的内置模块（`node:fs` 等）。给 agent 暴露一个 MCP 工具：

```js
export const name = "pigcode-<slug>"
export const inject = ["mcp"]

export function apply(ctx) {
  ctx.effect(() =>
    ctx.mcp.registerTool(
      "pigcode-<slug>",
      {
        name: "<slug>_count_words",
        description: "给模型看的说明：这个工具做什么、什么时候用",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
      },
      async (input, { threadId }) => ({
        words: String(input.text).split(/\s+/).filter(Boolean).length,
      }),
    ),
  )
}
```

- 用 `ctx.effect` 包住注册：插件停用时工具一起注销。工具的返回值要能 JSON 序列化。
- 其他能用的：`ctx.provide(name, value)` 注册一个服务（同时在 manifest 的 `provides` 里写上同一个名字）；`ctx.sessions.read(threadId, 0)` 只读地读线程事件（`inject` 里加 `sessions`）。

### 5. 界面入口（client.js）

在窗口里运行。`react` 和 `@pigcode/ui-primitives` 由 Pigcode 提供，直接按包名 import，不要自带 React。不用 JSX，写 `createElement`：

```js
import { createElement as h, useState } from "react"
import {
  Button,
  ListRow,
  SettingRow,
  SettingSection,
  Switch,
  useLocale,
} from "@pigcode/ui-primitives"

function Panel() {
  const { locale } = useLocale()
  const [count, setCount] = useState(0)
  const label = locale.startsWith("en") ? `Clicked ${count}` : `点了 ${count} 次`
  return h(Button, { variant: "primary", onClick: () => setCount(count + 1) }, label)
}

function Settings() {
  const [on, setOn] = useState(false)
  return h(
    SettingSection,
    { title: "显示名" },
    h(
      SettingRow,
      { title: "开关" },
      h(Switch, { checked: on, onCheckedChange: setOn, "aria-label": "开关" }),
    ),
  )
}

export function apply(ctx) {
  const disposers = [
    ctx.panels.register({ id: "<slug>-panel", title: "显示名", Component: Panel }),
    ctx.surfaces.register({
      id: "<slug>-view",
      title: "显示名",
      description: "启动器里的一句说明",
      Component: Panel,
    }),
    ctx.settingsPages.register({ id: "<slug>-settings", title: "显示名", Component: Settings }),
    ctx.commands.register({ id: "<slug>-run", title: "命令名", slash: "<slug>", run() {} }),
  ]
  return () => disposers.forEach((dispose) => dispose())
}
```

- 扩展点：`panels`（左侧栏的区块）、`surfaces`（右侧面板的标签页）、`settingsPages`（设置里的一页）、`commands`（命令面板 ⌘K 与输入框 `/`）、`toolRenderers`（时间线里工具调用的显示：`{ id, tools: ["工具名"], Component }`，组件收到 `{ tool }`）。
- 只登记需要的；`id` 在同一个扩展点里唯一；在 `apply` 里同步登记，返回一个把它们全部注销的函数。
- 界面用 ui-primitives 的组件（Button、ListRow、SettingSection、SettingRow、Switch、Badge、EmptyState 等），不写死颜色和尺寸；文案按 `useLocale().locale` 区分中英文。

### 6. 插件市场的目录文件

`plugins/.pigcode-plugin/marketplace.json`：

```json
{
  "name": "dev-<project>",
  "displayName": "<project> 的插件",
  "plugins": [
    {
      "name": "pigcode-<slug>",
      "source": "./<slug>",
      "displayName": "显示名",
      "description": "一句话说明",
      "version": "0.1.0"
    }
  ]
}
```

- 市场的 `name` 只用小写字母、数字、`.`、`_`、`-`（用项目文件夹名转成小写连字符）。
- 每个条目的 `name` 和插件 package.json 的 `name` 一致，`version` 和 package.json 同步。
- 文件已经存在时只增改对应的条目，保留其他条目和字段。

### 7. 检查

- 有 Node 时用 `node --check` 检查每个 .js 文件；确认 JSON 都能解析、入口文件存在、没有留下 TODO。
- 不要改 Pigcode 的安装目录或配置文件，也不要替我安装插件。

### 8. 完成后告诉我

- 插件目录和 `plugins/` 的绝对路径、包名与版本。
- 安装：在 Pigcode 侧栏打开「插件」→「添加」→「添加插件市场」，填 `plugins/` 的绝对路径并勾选风险确认；然后在「插件市场」里找到这个插件，点「安装」。
- 以后修改：改完把 package.json 和市场文件里的 `version` 加一，在「插件市场来源」里刷新这个市场，再点插件的「更新」。
- 在我装好并试用之前，说明这一步还需要我来做。
