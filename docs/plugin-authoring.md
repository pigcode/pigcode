# Pigcode 插件开发指南

Pigcode 插件就是普通的 npm 包：没有 `bundle-` 前缀，也没有第二套 manifest。
插件可以只提供 Host 代码、只提供 UI 代码，或两者都提供。本文覆盖最小可运行结构、
`package.json` 声明、agent（provider）/ capability / UI 三类示例，以及安装、启停和冲突规则。

驱动会话的 agent 本身也是插件：Claude Code 与 Codex 是随应用内置的 provider 插件，
其他 agent 由用户按需安装，写法见 [agent（provider）插件](#agentprovider插件)。

## 目录结构

一个最小的 Host 插件（agent 或 capability）：

```text
my-plugin/
├── package.json   # 唯一的 manifest：package.json 的 pigcode 字段
└── index.ts       # Host 入口（TypeScript），在 Host 进程内运行
```

一个最小的 UI 插件：

```text
my-ui-plugin/
├── package.json   # pigcode.client 指向浏览器入口
└── client.ts      # UI 入口（TypeScript），在渲染进程的受限 facade 中运行
```

同时提供两类入口时，把 `index.ts` 与 `client.ts` 放在同一个包里，并在
`pigcode.host` 和 `pigcode.client` 中分别声明即可。

## TypeScript

插件直接用 TypeScript 编写，不需要单独的构建步骤：

- `main`、`pigcode.host`、`pigcode.client` 可以直接指向 `.ts` / `.mts` 文件。
- 安装时 Host 用 Node 内置的 `stripTypeScriptTypes` 把包里的 `.ts` / `.mts` 转成同名 `.mjs`，
  并把 profile 里那份副本的入口改指向转换结果；插件源目录保持不变。
- 包内的相对导入写完整扩展名（`import { x } from "./util.ts"`），安装时会一起改成 `.mjs`。
- 类型只用 `import type` 引入，例如 `import type { PluginHostContext } from "@pigcode/plugin-sdk"`；
  类型导入在转换时被擦除，运行时不依赖 SDK。
- `enum`、`namespace` 等需要改写的语法也能转换，但推荐只用可擦除的语法（`erasableSyntaxOnly`）。
- 已经编译成 `.js` / `.mjs` 的 npm 包照常可用；入口不是 TypeScript 时 Host 不做任何转换。

## package.json 的 pigcode 声明

```json
{
  "name": "pigcode-provider-echo",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.ts",
  "engines": {
    "pigcode": ">=0.1.0"
  },
  "pigcode": {
    "apiVersion": 1,
    "kind": "provider",
    "displayName": "Echo",
    "host": "./index.ts",
    "client": "./client.ts",
    "inject": ["providers"],
    "provides": ["provider:echo"],
    "contributes": {
      "provider": {
        "id": "echo"
      }
    },
    "permissions": []
  }
}
```

| 字段              | 必填 | 说明                                                                   |
| ----------------- | ---- | ---------------------------------------------------------------------- |
| `apiVersion`      | 是   | 当前只支持 `1`；其他值会让插件被拒绝加载。                             |
| `kind`            | 是   | `provider`（agent）、`capability`、`ui` 或 `bundle`。                  |
| `displayName`     | 否   | 插件管理界面展示的名称，缺省使用包名。                                 |
| `host`            | 否   | Host 入口的相对路径。`host` 与 `client` 至少要有一个。                 |
| `client`          | 否   | UI 入口的相对路径。                                                    |
| `inject`          | 否   | 依赖声明，默认 `[]`。Host 侧服务名如 `providers`、`sessions`。         |
| `provides`        | 否   | 提供的能力标识，默认 `[]`；用于启用时的冲突检测。                      |
| `contributes`     | 否   | 贡献点元数据，默认 `{}`；agent 的 `provider` 贡献会被校验，见下文。    |
| `permissions`     | 否   | 权限声明，默认 `[]`；安装和列表界面会展示给用户。                      |
| `engines.pigcode` | 否   | semver 范围，按 Host 当前版本（`0.1.0`）校验；不满足时插件被标记错误。 |

补充说明：

- Host 入口模块还要 `export const inject = [...]`，Cordis 会等这些服务就绪后再调用
  `apply`。`package.json` 里的 `pigcode.inject` 是 manifest 声明，UI boot graph 也会携带它。
- `permissions` 目前是展示型声明，不做运行时授权或拦截；Host 插件始终以 Host 进程权限运行，
  所以安装时务必只选择可信来源。
- 兼容性不通过时，插件仍会显示在列表中并附带错误原因，但 Host 入口不会被加载。

## agent（provider）插件

agent 是 `kind` 为 `provider` 的插件：它在 Host 里注册一个 driver，把某个 coding agent
（CLI、SDK 或远程服务）接到 Pigcode 的会话、审批和时间线上。

- **内置**：Claude Code（[`packages/agent-claude`](../packages/agent-claude)）和 Codex
  （[`packages/agent-codex`](../packages/agent-codex)）随应用发布，列在核心 profile 的
  `builtinPlugins` 里。它们可以在 **设置 → Agent** 里停用，但不能卸载。
- **按需安装**：其他 agent 在 **设置 → Agent → 安装 agent** 里安装（npm 包、tarball 或本地目录）。
  装好后和内置 agent 一样出现在设置页和输入框的模型选择器里，也可以随时卸载。

完整可运行示例见 [`examples/provider-echo`](../examples/provider-echo)：它把用户输入回显出来，
并演示设置字段怎样传到 driver。

### 介绍与设置字段

agent 的介绍和设置字段写在 `package.json` 的 `contributes.provider` 里。设置页据此生成表单，
插件不需要写 UI 代码：

```json
{
  "pigcode": {
    "apiVersion": 1,
    "kind": "provider",
    "displayName": "Echo",
    "host": "./index.ts",
    "inject": ["providers"],
    "provides": ["provider:echo"],
    "permissions": [],
    "contributes": {
      "provider": {
        "id": "echo",
        "description": {
          "zh-CN": "示例 agent：把你的消息原样回显，用来试插件与设置。",
          "en-US": "Example agent that echoes your message back, for trying plugins and settings."
        },
        "settings": [
          {
            "key": "prefix",
            "type": "text",
            "label": { "zh-CN": "回复前缀", "en-US": "Reply prefix" },
            "placeholder": "echo:"
          },
          {
            "key": "uppercase",
            "type": "boolean",
            "label": { "zh-CN": "转成大写", "en-US": "Uppercase" }
          }
        ]
      }
    }
  }
}
```

| 字段           | 必填 | 说明                                                                          |
| -------------- | ---- | ----------------------------------------------------------------------------- |
| `id`           | 是   | agent id，小写字母开头，可含数字、`.`、`_`、`-`；必须和 driver 的 `id` 一致。 |
| `description`  | 否   | 设置页里的介绍。                                                              |
| `homepage`     | 否   | 官网，设置页显示为“官网”链接；只接受 https 地址。                             |
| `installHint`  | 否   | 检测到 agent 没安装时给用户的提示，例如安装命令。                             |
| `settings`     | 否   | 设置字段，默认 `[]`；`key` 不能重复。                                         |
| `customModels` | 否   | 是否允许用户添加自定义模型 id，默认 `true`。                                  |

没写 `contributes.provider` 时，Host 从 `provides` 里的 `provider:<id>` 推断 agent id，
设置页只显示自定义模型。`description`、`label`、`placeholder` 等文案可以是一段文字，
也可以按 locale 写成 `{ "zh-CN": "…", "en-US": "…" }`。

每个设置字段有 `key`、`label`、可选的 `description`，以及下面某一种 `type`：

| `type`    | 值                     | 界面                | 额外属性                                                  |
| --------- | ---------------------- | ------------------- | --------------------------------------------------------- |
| `text`    | 字符串                 | 输入框              | `placeholder`；`monospace: true` 用等宽字体，适合启动参数 |
| `path`    | 字符串                 | 输入框加“选择…”按钮 | `placeholder`；`pathKind` 为 `file`（默认）或 `directory` |
| `boolean` | 布尔                   | 开关                | `default`                                                 |
| `select`  | 字符串                 | 下拉框              | `options: [{ value, label }]`（至少一项）、`default`      |
| `env`     | `{ name, value }` 数组 | 环境变量表格        | 变量名须符合 `[A-Za-z_][A-Za-z0-9_]*`                     |

字段都可以留空，留空表示用 agent 自己的默认值；保存时 Host 丢掉空字符串和空列表，
值存在用户 profile 的 `settings.json` 里。`customModels` 是保留键：用户添加的模型 id
由 Host 追加到这个 agent 的模型目录（选择器里标为“自定义”），插件不需要处理。

内置 agent 的字段可以当作参考：Claude Code 有可执行文件、`CLAUDE_CONFIG_DIR`、
启动参数和环境变量；Codex 有可执行文件、`CODEX_HOME`、启动参数和环境变量。

### driver 契约

`index.ts` 导出 `apply(ctx)`，在 `ctx.providers` 上注册一个
[`ProviderPluginDriver`](../packages/plugin-sdk/src/provider.ts)：

| 方法                            | 必须 | 说明                                                                                     |
| ------------------------------- | ---- | ---------------------------------------------------------------------------------------- |
| `detect(settings)`              | 否   | 只读检测：是否安装、版本、登录状态；不能触发登录。没实现时视为可用。                     |
| `listModels(settings)`          | 否   | 模型目录；没实现时只列出用户的自定义模型。                                               |
| `createSession(input)`          | 是   | 每个 run 开始前调用。`input.settings` 是最新保存的设置；复用会话时带 `input.sessionId`。 |
| `send(session, input, runtime)` | 是   | 执行一条用户输入，通过 `runtime.emit` 推送事件。                                         |
| `interrupt(session)`            | 是   | 中断当前 run；Host 同时会中止 `runtime.signal`。                                         |
| `dispose(session)`              | 是   | 释放会话资源：线程切换 agent 时调用；插件停用时 Host 只对运行中的会话调用。              |

几条约定：

- 设置改了不需要重新注册 driver。检测、列模型、建会话时 Host 都传入最新的设置；
  已经在跑的 run 不受影响，改动从下一个 run 开始生效。driver 如果复用常驻进程，要按设置判断
  能不能复用（Codex 插件比较 app-server 的启动命令，变了就启动新进程）。
- 会话 id 是 Host 数据库的主键：`input.sessionId` 存在时原样使用，否则生成一个全局唯一的 id。
  同一个线程切到别的 agent 再切回来时，Host 会要求创建新会话。
- 检测结果缓存 30 秒，模型目录缓存 10 分钟。保存设置会清掉这两份缓存，
  设置页的“重新检测”跳过检测缓存。

示例 `index.ts`：

```ts
/** 示例 agent（provider）插件：把用户输入原样回显，演示设置字段怎样传到 driver。 */
import type {
  PluginHostContext,
  ProviderPluginDriver,
  ProviderSettingsValues,
} from "@pigcode/plugin-sdk"

export const name = "provider-echo"
export const inject = ["providers"]

/** 设置值来自用户输入，读取时校验类型；第三方插件只能 import type，运行时不依赖 SDK。 */
function text(settings: ProviderSettingsValues | undefined, key: string): string {
  const value = settings?.[key]
  return typeof value === "string" ? value.trim() : ""
}

export function apply(ctx: PluginHostContext): void {
  // 每个 run 开始前 Host 都会用最新的设置调用 createSession；按会话记下这一份。
  const settingsBySession = new Map<string, ProviderSettingsValues>()
  const driver: ProviderPluginDriver = {
    id: "echo",
    displayName: "Echo",
    capabilities: {
      streaming: true,
      approvals: false,
      questions: false,
      plan: false,
      resume: false,
      fork: false,
      rollback: false,
      checkpoint: false,
      subagents: false,
      mcp: false,
      images: false,
      usage: false,
      modelCatalog: false,
      nativeSessionId: false,
    },
    async createSession(input) {
      // 会话 id 是 Host 数据库的主键：复用时沿用 Host 给的 id，新会话必须全局唯一。
      const id = input.sessionId ?? `echo_${crypto.randomUUID()}`
      settingsBySession.set(id, input.settings ?? {})
      return {
        id,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: "workspace-write",
        model: null,
      }
    },
    async send(session, input, runtime) {
      const settings = settingsBySession.get(session.id)
      const prefix = text(settings, "prefix")
      const body = settings?.uppercase === true ? input.text.toUpperCase() : input.text
      const reply = prefix ? `${prefix} ${body}` : body
      runtime.emit({ type: "run.started" })
      runtime.emit({ type: "message.delta", text: reply })
      runtime.emit({ type: "message.completed", text: reply })
      runtime.emit({ type: "run.completed" })
    },
    async interrupt() {},
    async dispose(session) {
      settingsBySession.delete(session.id)
    },
  }
  ctx.providers.register(driver)
  // 热停用时必须注销，否则 agent 仍会出现在输入框的选择器里。
  ctx.effect(() => () => ctx.providers.unregister("echo"))
}
```

`send` 通过 `runtime.emit` 推送规范化事件，可用事件类型见
[`packages/contracts/src/events.ts`](../packages/contracts/src/events.ts) 中的 `ProviderEvent`。
需要审批时调用 `runtime.requestApproval`；`capabilities.questions` 为 `true` 时可以用
`runtime.askQuestions` 向用户提问；取消通过 `runtime.signal` 观察。

### MCP 工具

capability 插件注册的 MCP 工具通过 `input.mcp` 交给声明了 `capabilities.mcp: true` 的 agent；
没有工具时 Host 不传。`input.mcp` 不依赖任何 agent 的 SDK，按 agent 接入 MCP 的方式二选一：

- `tools` 与 `callTool(name, input)`：能在进程内挂 MCP server 的 agent 用它们自己建 server
  （Claude Code 插件用 Claude Agent SDK 的 `createSdkMcpServer`），`toolResultContent`
  把工具结果转成 MCP 内容。
- `stdioServer()`：返回 `{ command, args, env }`，以子进程连接 MCP 的 agent 把它写进自己的配置
  （Codex 插件写成 `mcp_servers.pigcode`）。

### 停用、卸载与清理

插件停用或卸载时，Host 取消这个 agent 排队中的 run、中断运行中的 run，并对它们的会话调用
`dispose`。插件自己还要：

- 用 `ctx.effect(() => () => ctx.providers.unregister(id))` 注销 driver，否则它仍会出现在选择器里；
- 关掉自己启动的常驻进程、socket 和定时器。内置的 Claude Code 与 Codex 插件在同一个 effect 里
  注销 driver 并调用 `driver.close()`。

### 依赖与 SDK 辅助函数

第三方插件只能 `import type` SDK：安装时类型导入被擦除，运行时没有 `@pigcode/plugin-sdk`，
也不要 `import` `@pigcode/host` 的内部路径。运行时保持零依赖，或只依赖自己的 npm 依赖。
设置值来自用户输入，读取时自己校验类型（例如示例里的 `text()`）。

`@pigcode/plugin-sdk` 与 `@pigcode/plugin-sdk/node` 的运行时辅助函数（`settingString`、
`settingEnvironment`、`tokenizeCliArgs`、`resolveExecutable`、`providerEnvironment` 等）
供随应用打包的内置 agent 使用。第三方插件需要同样的逻辑时，把代码复制过去或者自己打包进入口。

## capability 插件

完整示例见 [`examples/capability-session-info`](../examples/capability-session-info)。
capability 通过 `ctx.provide` 暴露能力，使用只读的 `ctx.sessions`：

```ts
/** 示例 capability：暴露当前线程的事件数量。 */
import type { PluginHostContext } from "@pigcode/plugin-sdk"

export const name = "capability-session-info"
export const inject = ["sessions"]

export function apply(ctx: PluginHostContext): void {
  ctx.provide("sessionInfo", {
    count(threadId: string): number {
      return ctx.sessions.read(threadId, 0).length
    },
  })
}
```

`ctx` 上可用的 Host 能力：

- `ctx.sessions.read(threadId, cursor)`：只读读取线程事件；需要 `inject: ["sessions"]`。
- `ctx.provide(name, value)`：注册一个供其他插件或 Host 使用的能力。
- `ctx.effect(setup)`：注册随插件卸载执行的清理逻辑。
- `ctx.providers.register` / `ctx.providers.unregister`：注册或移除 agent driver。
- `ctx.mcp.registerTool`：把工具暴露给支持 MCP 的 agent（Claude Code、Codex 等）；需要 `inject: ["mcp"]`。

## 通过 MCP 暴露工具

capability 插件可以用 `ctx.mcp.registerTool` 注册工具；Host 会把它注入当前线程的
agent 会话（Claude Code、Codex，或声明了 `capabilities.mcp` 的第三方 agent）。完整示例见
[`examples/capability-clock`](../examples/capability-clock)：

```ts
/** 示例 capability：通过 MCP 向模型暴露当前时间。 */
import type { PluginHostContext } from "@pigcode/plugin-sdk"

export const name = "capability-clock"
export const inject = ["mcp"]

export function apply(ctx: PluginHostContext): void {
  // ctx.effect 保证插件停用/卸载时注销工具；工具随插件一起消失。
  ctx.effect(() =>
    ctx.mcp.registerTool(
      "pigcode-capability-clock",
      {
        name: "clock_now",
        description: "Return the current ISO time",
        inputSchema: { type: "object", properties: {} },
      },
      async (_input, { threadId }) => {
        return { now: new Date().toISOString(), threadId }
      },
    ),
  )
}
```

规则：

- `registerTool(pluginId, tool, handler)` 返回注销函数；用 `ctx.effect` 包住它，
  插件停用时工具会从后续会话中消失。
- `tool.name` 是模型看到的工具名；`inputSchema` 使用 JSON Schema，agent 插件会转换成
  各自需要的形状。返回值必须可 JSON 序列化。
- handler 的第二个参数是 `{ threadId }`，表示发起本次 run 的线程。工具注册表是
  Host 全局的，但每次调用都带线程作用域，因此并行会话不会共享可变调用状态。
- Host 把工具表交给 agent 插件（见 [MCP 工具](#mcp-工具)），由插件接到自己的 agent 上：
  Claude Code 插件用工具表建进程内 MCP server（`mcpServers.pigcode`）；Codex 插件把
  `stdioServer()` 写进 `mcp_servers.pigcode`，由 stdio bridge 经 Unix domain socket / 命名管道
  连回 Host，并在 hello 时用一次性 token 绑定线程。Host 不监听 TCP 端口。
- 没有任何已注册工具时，Host 不会注入空 MCP 配置。

## UI 插件

完整示例见 [`examples/ui-debug-panel`](../examples/ui-debug-panel)。UI 插件只拿到受限 facade，
不依赖 React；界面和宿主保持一致的做法是：**宿主画外框，插件只画内容，内容用 `ctx.ui` 拼**。

### 侧栏面板与右栏标签

```ts
import type { ClientPluginContext } from "@pigcode/plugin-sdk"

export function apply(ctx: ClientPluginContext): () => void {
  // 侧栏：标题由宿主画成和「项目」一样的分组标题，点击可以收起。
  const disposePanel = ctx.registerPanel({
    id: "demo-panel",
    title: "Demo",
    render(container) {
      container.append(ctx.ui.text("Hello from my UI plugin", { tone: "muted", size: "sm" }))
    },
  })
  // 右栏：出现在启动器和「+」菜单的「插件」组里，打开后是和文件、终端一样的标签。
  const disposeSurface = ctx.registerSurface({
    id: "demo-inspector",
    title: "Demo Inspector",
    description: "启动器里悬停显示的一句说明",
    render(container) {
      container.append(
        ctx.ui.section({
          title: "状态",
          children: [ctx.ui.row({ title: "主题", control: ctx.ui.badge(ctx.theme.get()) })],
        }),
      )
      // 返回的函数在标签关闭、插件停用或内容重画前调用。
      return ctx.theme.subscribe(() => undefined)
    },
  })
  return () => {
    disposePanel()
    disposeSurface()
  }
}
```

- `render(container)` 可以返回清理函数；宿主在移除或重画前调用它，然后清空容器。
  `render` 抛出的错误显示在内容区里，不影响宿主。
- 容器带 `pg-root` 类：字体、字号、颜色和行高已经是宿主的；侧栏面板（`pg-panel`）是紧凑排版，
  右栏标签（`pg-surface`）带内边距、最宽 720px。
- 插件停用或卸载后，已经打开的右栏标签会显示“插件已停用或卸载”，用户可以直接关掉。

### 和宿主一致的组件：`ctx.ui`

`ctx.ui` 返回普通的 DOM 元素，插件自己 `append` 到容器里。按钮、输入框、开关和徽标直接用宿主控件的类
（`btn`、`input`、`switch`、`badge`），跟随宿主的主题、强调色与字号；其余用 `pg-*` 排版：

| 方法                                                | 生成的元素                                                            |
| --------------------------------------------------- | --------------------------------------------------------------------- |
| `section({ title?, description?, children? })`      | 带标题的分组，内容是一张卡片（侧栏里没有卡片背景）                    |
| `row({ title, description?, control? })`            | 设置行：左边标题与说明，右边是控件                                    |
| `button({ label, variant?, disabled?, onClick? })`  | 按钮；`variant` 为 `primary`、`secondary`（默认）、`ghost`、`danger`  |
| `input({ label, value?, placeholder?, onChange? })` | 文本输入框，`label` 作为无障碍名称                                    |
| `toggle({ label, checked, onChange? })`             | 开关（`role="switch"`）                                               |
| `badge(label, tone?)`                               | 徽标；`tone` 为 `neutral`、`accent`、`success`、`warning`、`danger`   |
| `text(content, { tone?, size? })`                   | 一段文字；`tone` 为 `default`、`muted`、`faint`，`size` 为 `md`、`sm` |
| `code(content)`                                     | 等宽代码块                                                            |
| `list(items)`                                       | 一列条目：`title`、`description`、`meta`，给 `onClick` 时整行可点     |
| `empty({ title, description? })`                    | 空状态                                                                |

### 宿主的主题与语言

- `ctx.theme.get()` 返回 `"light"` 或 `"dark"`，`ctx.theme.subscribe(listener)` 在切换时通知，返回取消订阅函数。
- `ctx.locale.get()` 返回界面语言（`zh-CN`、`en-US`），`ctx.locale.subscribe` 同上。插件的文案自己按语言选择。

### 自己写样式

需要 `ctx.ui` 以外的样式时，只用下面这些 CSS 变量，不要写死颜色——它们跟随宿主的主题、强调色与字号：

| 变量                                                  | 用途                             |
| ----------------------------------------------------- | -------------------------------- |
| `--pg-font`、`--pg-mono`                              | 界面字体、等宽字体               |
| `--pg-fs`、`--pg-fs-sm`                               | 正文字号、小字号                 |
| `--pg-fg`、`--pg-fg-2`、`--pg-muted`、`--pg-faint`    | 文字：主要、次要、说明、最弱     |
| `--pg-bg`、`--pg-surface`、`--pg-field`、`--pg-hover` | 背景：内容区、卡片、输入框、悬停 |
| `--pg-border`、`--pg-divider`                         | 边框与分隔线                     |
| `--pg-accent`、`--pg-accent-soft`                     | 强调色与它的浅色底               |
| `--pg-success`、`--pg-warning`、`--pg-danger`         | 状态文字色                       |
| `--pg-radius`、`--pg-radius-sm`                       | 卡片与控件圆角                   |

### slot

也可以向内置 slot 注册条目：

```ts
import type { ClientPluginContext } from "@pigcode/plugin-sdk"

export function apply(ctx: ClientPluginContext): () => void {
  const dispose = ctx.slots.register("settings.section", {
    id: "demo-settings",
    order: 20,
    // 返回值交给 React 渲染；纯 DOM 内容请用 registerPanel。
    render: (props: { section?: string }) => `Demo section: ${props?.section ?? "general"}`,
  })
  return () => dispose()
}
```

slot 规则：

- 允许的名称：`sidebar.section`、`chat.view`、`settings.section`、`panel.right`、`status.bar`。
  当前主界面实际挂载的是 `chat.view` 与 `settings.section`；其余名称需要对应宿主挂载点才会显示。
- 未注册的名称会被忽略，不会抛异常。
- 同一 slot 内 `id` 必须唯一。重复注册会显式失败：第二次注册被拒绝，并记录
  `SLOT_CONFLICT`（控制台和插件错误表），不会静默覆盖。
- 第三方 client bundle 无法解析裸 `react` 导入，因此需要真实 DOM 界面时用
  `ctx.registerPanel` 或 `ctx.registerSurface`；`ctx.slots.register` 适合返回字符串等 React 可渲染的原始值。
- `ctx.host.call(method, params)` 通过现有 MessagePort RPC 调用 Host，不引入 HTTP/WebSocket/token。

UI 插件运行在渲染进程，不应访问 Node 或 Electron API。

## 启停与冲突规则

启用和停用都是热生效，不需要重启应用：

1. 启用时先计算“当前已启用插件 + 目标插件”的 `provides`。只要有一个能力标识被多个插件声明
   （包括同一插件重复声明），就抛出 `PROVIDES_CONFLICT`，附带冲突能力和插件 id，并拒绝启用。
2. 检查通过后，Host 入口被动态挂载，agent / capability 立即可用。
3. boot graph 立即重写；渲染进程重新加载 UI client bundle，新插槽和面板出现。
4. 停用时会卸载 Host 入口并等待 `ctx.effect` 清理，agent / capability 立即消失；
   boot graph 重写后，对应的 UI 面板和 slot 条目也会移除。停用 agent 还会取消它排队中的 run、
   中断运行中的 run 并释放会话。

因此插件必须正确清理自己注册的东西：agent 用
`ctx.effect(() => () => ctx.providers.unregister(id))`，UI 插件返回 `apply` 的清理函数。
`apiVersion` 或 `engines.pigcode` 不兼容的插件不会被 Host 加载，列表里会显示错误原因。

## 安装与卸载

桌面端有两个入口，背后是同一套安装流程：

- **设置 → Agent → 安装 agent**：安装 agent 插件，可以用“选择文件夹…”挑本地目录。
- **设置 → 插件 → 安装插件**：安装任意种类的插件。两个入口是同一个对话框：填插件目录或 npm 包，
  或者用“选择文件夹…”。插件管理页和 Agent 页是同一种列表，开关启停，点开一行看包名、权限与卸载。

可以填的内容：

- 本地目录：绝对路径（例如 `/tmp/pigcode-plugin-demo` 或 `C:\plugins\demo`）、`./` 开头的相对路径
  或 `file:` 前缀。Host 把目录复制到用户 profile 的 `node_modules/<包名>`，插件源目录保持不变。
- npm：包名、版本或 tarball，例如 `my-pigcode-plugin@1.0.0` 或 `/tmp/pkg.tgz`；
  Host 通过 `pnpm add` 安装到用户 profile。
- 对应的 Host RPC：`plugin.install`，参数 `{ "spec": "my-pigcode-plugin@1.0.0" }`，本地目录也可以；
  只装本地目录时也可以用 `plugin.installLocal`，参数 `{ "sourceDir": "/abs/path/to/plugin" }`。

装好的插件立即启用。两个页面都可以卸载用户安装的插件（RPC `plugin.uninstall`，参数 `{ "id": … }`）：
Host 先卸下插件的 Host 入口并等待 `ctx.effect` 清理，再删除 `node_modules` 里的包和列表里的记录。
agent 的设置值保留在 `settings.json` 里，重新安装后还在。内置插件不能卸载，
对它们调用 `plugin.uninstall` 会得到 `PLUGIN_BUILTIN` 错误。

安装的插件和启停状态记在用户 profile 目录的 `plugins.yml` 里；内置插件只记录是否停用。
用户 profile 默认在 Electron `userData` 下的 `profiles/desktop`，可以用环境变量 `PIGCODE_PROFILE_DIR`
指定。

安装前请确认插件来源可信：安装界面会展示 `permissions` 声明和“插件以 Host 权限运行”的风险提示。
权限声明目前只用于展示，不会限制插件能力。

## 脚手架

在 `frontend/` 下运行：

```bash
pnpm create-plugin <dir> <kind> <name>
# 等价于
node scripts/create-plugin.ts <dir> <kind> <name>
```

- `kind`：`provider`（agent）、`capability` 或 `ui`。
- `name`：小写字母开头的插件标识，可含数字、点、下划线、连字符。
- `dir`：目标目录，不存在时创建；若已有同名文件且内容不同，脚本会拒绝覆盖。

示例：

```bash
pnpm create-plugin /tmp/pigcode-plugin-demo ui demo
```

生成结果：

```text
/tmp/pigcode-plugin-demo/
├── package.json   # name: pigcode-ui-demo
└── client.ts      # 侧栏面板与右栏标签
```

agent（provider）/ capability 会生成 `package.json` 和 `index.ts`。脚本结束时打印本地安装路径：
agent 填进 **设置 → Agent → 安装 agent**，其他插件填进 **设置 → 插件** 的“插件目录或 npm 包”。
