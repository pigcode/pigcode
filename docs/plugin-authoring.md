# Pigcode 插件开发指南

Pigcode 插件就是普通的 npm 包：没有 `bundle-` 前缀，也没有第二套 manifest。
插件可以只提供 Host 代码、只提供 UI 代码，或两者都提供。本文覆盖最小可运行结构、
`package.json` 声明、Agent / Capability / UI 三类插件的示例，以及安装、启停和冲突规则。

驱动会话的 agent 本身也是插件：Claude Code 与 Codex 是随应用内置的 Agent 插件，
其他 agent 由用户按需安装，写法见 [Agent 插件](#agent-插件)。

## 目录结构

一个最小的 Host 插件（Agent 插件或 Capability 插件）：

```text
my-plugin/
├── package.json   # 唯一的 manifest：package.json 的 pigcode 字段
└── index.ts       # Host 入口（TypeScript），在 Host 进程内运行
```

一个最小的 UI 插件：

```text
my-ui-plugin/
├── package.json   # pigcode.client 指向浏览器入口
└── client.tsx     # UI 入口（TypeScript + JSX），在渲染进程里用宿主的 React 运行
```

同时提供两类入口时，把 `index.ts` 与 `client.tsx` 放在同一个包里，并在
`pigcode.host` 和 `pigcode.client` 中分别声明即可。

## TypeScript 与 TSX

插件直接用 TypeScript 编写，不需要单独的构建步骤：

- `main`、`pigcode.host`、`pigcode.client` 可以直接指向 `.ts` / `.tsx` / `.mts` 文件。
- 安装时 Host 用 esbuild 把包里的 `.ts` / `.tsx` / `.mts` 转成同名 `.mjs`，
  并把 profile 里那份副本的入口改指向转换结果；插件源目录保持不变。
- `.tsx` 用自动 JSX runtime 编译（`jsx: "automatic"`）：编译结果从 `react/jsx-runtime` 取 `jsx`，
  运行时由宿主的共享模块提供，插件不需要自带 React，见 [使用宿主的 React](#使用宿主的-react)。
- 包内的相对导入写完整扩展名（`import { x } from "./panel.tsx"`），安装时会一起改成 `.mjs`。
- 类型只用 `import type` 引入，例如 `import type { PluginHostContext } from "@pigcode/plugin-sdk"`；
  类型导入在转换时被擦除，运行时不依赖 SDK。
- `enum`、`namespace` 等需要改写的语法也能转换，但推荐只用可擦除的语法（`erasableSyntaxOnly`）。
- 已经编译成 `.js` / `.mjs` 的 npm 包照常可用；入口不是 TypeScript 时 Host 不做任何转换。
- 如果插件用打包器自己构建，把宿主提供的模块标为 external（见
  [构建时的 external](#构建时的-external)），不要把它们打进插件。

## package.json 的 pigcode 声明

```json
{
  "name": "pigcode-agent-echo",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.ts",
  "engines": {
    "pigcode": ">=0.1.0"
  },
  "pigcode": {
    "apiVersion": 1,
    "kind": "agent",
    "displayName": "Echo",
    "host": "./index.ts",
    "client": "./client.tsx",
    "inject": ["agents"],
    "provides": ["agent:echo"],
    "contributes": {
      "agent": {
        "id": "echo"
      }
    },
    "permissions": []
  }
}
```

| 字段              | 必填 | 说明                                                                                                               |
| ----------------- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| `apiVersion`      | 是   | 当前只支持 `1`；其他值会让插件被拒绝加载，错误写明插件需要的版本和 Host 支持的版本。                               |
| `kind`            | 是   | `agent`、`capability`、`ui` 或 `bundle`。                                                                          |
| `displayName`     | 否   | 插件管理界面展示的名称，缺省使用包名。                                                                             |
| `host`            | 否   | Host 入口的相对路径。`host` 与 `client` 至少要有一个。                                                             |
| `client`          | 否   | UI 入口的相对路径。                                                                                                |
| `inject`          | 否   | 依赖声明，默认 `[]`。Host 侧服务名如 `agents`、`sessions`。                                                        |
| `provides`        | 否   | 提供的服务标识，默认 `[]`；用于安装、启动和启用时的冲突检测，先加载的保留。                                        |
| `contributes`     | 否   | 贡献点元数据，默认 `{}`；只读取 `agent`，见下文。`settings`、`commands`、`slots`、`rpc` 会被拒绝，其它键原样保留。 |
| `permissions`     | 否   | 权限声明，默认 `[]`；安装和列表界面会展示给用户。                                                                  |
| `engines.pigcode` | 否   | semver 范围，按 Host 当前版本（`0.1.0`）校验；不满足时插件被标记错误。                                             |

补充说明：

- Host 入口模块还要 `export const inject = [...]`，Cordis 会等这些服务就绪后再调用
  `apply`。`package.json` 里的 `pigcode.inject` 是 manifest 声明，UI boot graph 也会携带它。
- `permissions` 目前是展示型声明，不做运行时授权或拦截；Host 插件始终以 Host 进程权限运行，
  所以安装时务必只选择可信来源。
- 兼容性不通过时，插件仍会显示在列表中并附带错误原因，但 Host 入口不会被加载。

## Agent 插件

Agent 插件是 `kind` 为 `agent` 的插件：它在 Host 里注册一个 driver，把某个 coding agent
（CLI、SDK 或远程服务）接到 Pigcode 的会话、审批和时间线上。

- **内置**：Claude Code（[`packages/agent-claude`](../packages/agent-claude)）和 Codex
  （[`packages/agent-codex`](../packages/agent-codex)）随应用发布，列在核心 profile 的
  `builtinPlugins` 里。它们可以在 **设置 → Agent** 里停用，但不能卸载。
- **按需安装**：其他 agent 在 **设置 → Agent → 安装 agent** 里安装（npm 包、tarball 或本地目录）。
  装好后和内置 agent 一样出现在设置页和输入框的模型选择器里，也可以随时卸载。

完整可运行示例见 [`examples/agent-echo`](../examples/agent-echo)：它把用户输入回显出来，
并演示设置字段怎样传到 driver。

### 介绍与设置字段

agent 的介绍和设置字段写在 `package.json` 的 `contributes.agent` 里。设置页据此生成表单，
插件不需要写 UI 代码：

```json
{
  "pigcode": {
    "apiVersion": 1,
    "kind": "agent",
    "displayName": "Echo",
    "host": "./index.ts",
    "inject": ["agents"],
    "provides": ["agent:echo"],
    "permissions": [],
    "contributes": {
      "agent": {
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

没写 `contributes.agent` 时，Host 从 `provides` 里的 `agent:<id>` 推断 agent id，
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

`index.ts` 导出 `apply(ctx)`，在 `ctx.agents` 上注册一个
[`AgentDriver`](../packages/plugin-sdk/src/agent.ts)。`features` 声明这个 Agent 支持哪些 Agent 功能
（流式输出、审批、提问、计划模式、MCP 等），界面据此隐藏不支持的控件。driver 的方法：

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
/** 示例 Agent 插件：把用户输入原样回显，演示设置字段怎样传到 driver。 */
import type { AgentDriver, AgentSettingsValues, PluginHostContext } from "@pigcode/plugin-sdk"

export const name = "agent-echo"
export const inject = ["agents"]

/** 设置值来自用户输入，读取时校验类型；第三方插件只能 import type，运行时不依赖 SDK。 */
function text(settings: AgentSettingsValues | undefined, key: string): string {
  const value = settings?.[key]
  return typeof value === "string" ? value.trim() : ""
}

export function apply(ctx: PluginHostContext): void {
  // 每个 run 开始前 Host 都会用最新的设置调用 createSession；按会话记下这一份。
  const settingsBySession = new Map<string, AgentSettingsValues>()
  const driver: AgentDriver = {
    id: "echo",
    displayName: "Echo",
    features: {
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
  ctx.agents.register(driver)
  // 热停用时必须注销，否则 agent 仍会出现在输入框的选择器里。
  ctx.effect(() => () => ctx.agents.unregister("echo"))
}
```

`send` 通过 `runtime.emit` 推送规范化事件，可用事件类型见
[`packages/contracts/src/events.ts`](../packages/contracts/src/events.ts) 中的 `AgentEvent`。
需要审批时调用 `runtime.requestApproval`；`features.questions` 为 `true` 时可以用
`runtime.askQuestions` 向用户提问；取消通过 `runtime.signal` 观察。

### MCP 工具

Capability 插件注册的 MCP 工具通过 `input.mcp` 交给声明了 `features.mcp: true` 的 agent；
没有工具时 Host 不传。`input.mcp` 不依赖任何 agent 的 SDK，按 agent 接入 MCP 的方式二选一：

- `tools` 与 `callTool(name, input)`：能在进程内挂 MCP server 的 agent 用它们自己建 server
  （Claude Code 插件用 Claude Agent SDK 的 `createSdkMcpServer`），`toolResultContent`
  把工具结果转成 MCP 内容。
- `stdioServer()`：返回 `{ command, args, env }`，以子进程连接 MCP 的 agent 把它写进自己的配置
  （Codex 插件写成 `mcp_servers.pigcode`）。

### 停用、卸载与清理

插件停用或卸载时，Host 取消这个 agent 排队中的 run、中断运行中的 run，并对它们的会话调用
`dispose`。插件自己还要：

- 用 `ctx.effect(() => () => ctx.agents.unregister(id))` 注销 driver，否则它仍会出现在选择器里；
- 关掉自己启动的常驻进程、socket 和定时器。内置的 Claude Code 与 Codex 插件在同一个 effect 里
  注销 driver 并调用 `driver.close()`。

### 依赖与 SDK 辅助函数

Host 侧只给第三方插件 `import type` SDK：安装时类型导入被擦除，运行时没有 Host 的 `@pigcode/plugin-sdk`；
浏览器侧的 `@pigcode/plugin-sdk` 由宿主的共享模块提供，只有 `defineClientPlugin`，
也不要 `import` `@pigcode/host` 的内部路径。运行时保持零依赖，或只依赖自己的 npm 依赖。
设置值来自用户输入，读取时自己校验类型（例如示例里的 `text()`）。

`@pigcode/plugin-sdk` 与 `@pigcode/plugin-sdk/node` 的运行时辅助函数（`settingString`、
`settingEnvironment`、`tokenizeCliArgs`、`resolveExecutable`、`agentEnvironment` 等）
供随应用打包的内置 agent 使用。第三方插件需要同样的逻辑时，把代码复制过去或者自己打包进入口。

### 从 provider 迁移

Agent 插件以前叫 provider 插件。现在的 Host 不再接受旧写法，这是一项不兼容的变更：
manifest 里出现下表前三项中的任何一项都会校验失败。已安装的旧插件仍会显示在插件列表里，
状态为失败，错误信息写明要改成什么，例如
`kind "provider" was renamed to "agent" (see docs/plugin-authoring.md)`；
它的 Host 入口不会加载，但可以照常卸载。

| 旧写法                                                                     | 新写法                                                                     |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `"kind": "provider"`                                                       | `"kind": "agent"`                                                          |
| `contributes.provider`                                                     | `contributes.agent`                                                        |
| `provides` 里的 `provider:<id>`                                            | `agent:<id>`                                                               |
| 入口的 `inject = ["providers"]` 与 `ctx.providers`                         | `inject = ["agents"]` 与 `ctx.agents`                                      |
| driver 的 `capabilities`                                                   | `features`                                                                 |
| SDK 的 `Provider*` 类型、`providerEnvironment`、`readProviderContribution` | `Agent*` 类型、`agentEnvironment`、`readAgentContribution`                 |
| RPC 命令 `provider.*`、`thread.switchProvider`                             | `agent.*`（`provider.list` 改为 `agent.registered`）、`thread.switchAgent` |
| 环境变量 `PIGCODE_PROVIDER`                                                | `PIGCODE_AGENT`                                                            |

用户 profile 里的旧数据（`settings.json`、`plugins.yml` 与数据库）由 Host 启动时自动迁移，
插件作者不需要处理。

## Capability 插件

完整示例见 [`examples/capability-session-info`](../examples/capability-session-info)。
Capability 插件通过 `ctx.provide` 注册服务，使用只读的 `ctx.sessions`。在 `provides` 里声明的
标识要和 `ctx.provide` 的服务名一致（下面是 `sessionInfo`），这样两个插件提供同一个服务时，
启用第二个会因为冲突被拒绝，而不是悄悄覆盖第一个：

```ts
/** 示例 Capability 插件：暴露当前线程的事件数量。 */
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

`ctx` 上可用的 Host 服务：

- `ctx.sessions.read(threadId, cursor)`：只读读取线程事件；需要 `inject: ["sessions"]`。
- `ctx.provide(name, value)`：注册一个供其他插件或 Host 使用的服务。
- `ctx.effect(setup)`：注册随插件卸载执行的清理逻辑。
- `ctx.agents.register` / `ctx.agents.unregister`：注册或移除 agent driver；需要 `inject: ["agents"]`。
- `ctx.mcp.registerTool`：把工具暴露给支持 MCP 的 agent（Claude Code、Codex 等）；需要 `inject: ["mcp"]`。

## 通过 MCP 暴露工具

Capability 插件可以用 `ctx.mcp.registerTool` 注册工具；Host 会把它注入当前线程的
agent 会话（Claude Code、Codex，或声明了 `features.mcp` 的第三方 agent）。完整示例见
[`examples/capability-clock`](../examples/capability-clock)：

```ts
/** 示例 Capability 插件：通过 MCP 向模型暴露当前时间。 */
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
- 工具调用在时间线里的显示由[工具渲染器](#工具渲染器)决定；没有登记时用内置的 MCP 行。

## UI 插件

完整示例见 [`examples/ui-debug-panel`](../examples/ui-debug-panel)：它在五个扩展点上都登记内容，界面全部用
宿主的 React 和 `@pigcode/ui-primitives` 写。UI 插件写界面只有这一种做法：

- **React**：直接 `import "react"` 和 `import "@pigcode/ui-primitives"`，拿到的是宿主的同一个实例，
  插件界面和宿主用同一套组件（`Button`、`ListRow`、`SettingRow`、`SettingSection`、`Badge`、`Switch`、
  `EmptyState` 等）、同一份主题与语言。`examples/ui-react-panel` 是一个更小的 React 示例。

旧的 `ctx.ui` DOM 工具包已经删除，`render(container)` 的 DOM 渲染函数也已经删除：Panel、Surface、设置页和
工具渲染器只接受 React 组件（`Component`）。还在传 `render` 的插件在 `apply` 里第一次 `register` 时就抛错，
插件页显示成这个插件的界面代码错误，错误写明改成 `Component`。

所有路径都遵守「宿主画外框，插件只画内容」：Panel 的可收起标题、Surface 的标签、设置页的导航与标题都由宿主画。

### 使用宿主的 React

渲染进程在加载任何一个插件之前，就把下面这些模块作为共享模块准备好（ADR-0002）。插件按包名 import，
拿到的是宿主的同一个实例，而不是插件自己的一份：

| 包名                     | 拿到的东西                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `react`                  | 宿主的 React：hooks、context、`createElement`、`Fragment` 等                                                                                     |
| `react-dom`              | `createPortal`、`flushSync` 等                                                                                                                   |
| `react-dom/client`       | `createRoot`、`hydrateRoot`，插件可以把 React 挂到自己的容器里                                                                                   |
| `react/jsx-runtime`      | 自动 JSX runtime；`.tsx` 安装时编译成从这里 import。产物里的 `react/jsx-dev-runtime` 是 React 的生产 stub，`jsxDEV` 是 `undefined`，插件不要用它 |
| `@pigcode/ui-primitives` | 宿主的组件、设计 token，以及 `useLocale()`、`useTheme()`                                                                                         |
| `@pigcode/plugin-sdk`    | 浏览器侧的 SDK（`defineClientPlugin`）；类型用 `import type` 引入即可                                                                            |

要点：

- **必须是同一份 React。** 插件不要自带 React，也不要在打包时把 React 打进去。两个 React 实例会让 hooks 报错，
  context 也跨不过去。宿主的 import map 已经把包名指向宿主的模块，插件 bundle 里保留裸 import 就会落到同一份。
- **hooks 读得到宿主的状态。** 插件组件渲染在宿主的 React 树里：`useLocale()` 返回宿主的界面语言，
  `useTheme()` 返回 `"light"` 或 `"dark"`，切换后组件重画。`useState`、`useEffect`、`useContext` 等照常可用。
- **ui-primitives 是插件的公开 API。** 它的破坏性改动按插件 `apiVersion` 处理；升级插件 apiVersion 时按发布说明迁移。
- **绑定宿主的 React 大版本。** 当前是 React 19；插件声明的 `engines.pigcode` 把兼容范围写清楚。
- **共享模块在插件加载前就位。** 插件 bundle 加载时这些包名已经能解析，不需要先等宿主初始化；插件也不用
  `await import()` 它们。

### Panel、Surface 与设置页传组件

`ctx.panels.register`、`ctx.surfaces.register` 和 `ctx.settingsPages.register` 的内容都是 `Component`：
一个 React 组件（不接收 props），宿主在自己的 React 树里渲染它。旧的 `render(container)` DOM 渲染函数
已删除，传了会在 `register` 时抛错（见下）。

组件里用宿主 ui-primitives 的组件和宿主设置页的分组，Panel、Surface 和设置页因此和宿主长得一样：

```tsx
import { useState } from "react"
import {
  Badge,
  Button,
  ListRow,
  SettingRow,
  SettingSection,
  Switch,
  useLocale,
  useTheme,
} from "@pigcode/ui-primitives"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"

/** Panel 与 Surface 共用的内容：列表行、徽标与按钮都来自宿主。 */
function DemoContent() {
  const { locale } = useLocale()
  const theme = useTheme()
  const [count, setCount] = useState(0)
  return (
    <>
      <ListRow title="Theme" meta={<Badge variant="primary">{theme}</Badge>} />
      <ListRow title="Locale" meta={<Badge>{locale}</Badge>} />
      <Button variant="primary" onClick={() => setCount((value) => value + 1)}>
        Clicked {count}
      </Button>
    </>
  )
}

/** 设置页用和宿主设置页一样的分组与设置行。 */
function DemoSettings() {
  const [verbose, setVerbose] = useState(false)
  return (
    <SettingSection title="Demo">
      <SettingRow title="Verbose logging">
        <Switch checked={verbose} onCheckedChange={setVerbose} aria-label="Verbose logging" />
      </SettingRow>
    </SettingSection>
  )
}

export function apply(ctx: ClientPluginContext): () => void {
  const disposePanel = ctx.panels.register({
    id: "demo-panel",
    title: "Demo",
    Component: DemoContent,
  })
  const disposeSettings = ctx.settingsPages.register({
    id: "demo-settings",
    title: "Demo",
    Component: DemoSettings,
  })
  return () => {
    disposePanel()
    disposeSettings()
  }
}
```

- 内容只有 `Component` 一种写法；还在传 `render` 的登记直接抛错，插件页显示成界面代码错误，报错写明改用 `Component`。
- 组件渲染时抛出的错误只在内容区显示原因，时间线、侧栏和窗口其余部分照常可用。
  React 的错误边界接不到事件处理和异步回调里的错误，那些仍会冒到窗口；需要时自己 try/catch。
- 插件的文案仍然由插件自己按界面语言选择（组件里用 `useLocale()` 读语言）；宿主语言包只覆盖宿主自己的文字。
- 工具渲染器也接受 `Component`：组件收到 `{ tool }`，是这次调用的状态、输入与输出，见[工具渲染器](#工具渲染器)。

### 构建时的 external

如果插件用打包器（esbuild、Vite、Rollup 等）自己构建，把宿主的共享模块标为 external，
让产物里保留裸 import：

```ts
// esbuild
await build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  format: "esm",
  jsx: "automatic",
  external: [
    "react",
    "react-dom",
    "react-dom/client",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "@pigcode/ui-primitives",
    "@pigcode/plugin-sdk",
  ],
})
```

```ts
// Vite
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
        "@pigcode/ui-primitives",
        "@pigcode/plugin-sdk",
      ],
    },
  },
})
```

`external` 要同时列出裸包名和 `react/*`：只写 `"react/*"` 不会外置裸 `react`，React 本体仍会被打进插件，
和宿主分成两份；只写 `"react"` 又漏掉 `react/jsx-runtime`。

不自己构建时，把 `.tsx` 入口直接写进 `pigcode.client` 即可：安装时 Host 用 esbuild 只做转换、不打包，
裸包名原样留在产物里，由宿主的共享模块解析，不需要额外配置。

### 五个扩展点

窗口里只有五个扩展点。插件和内置功能遵守同样的规则：

| 扩展点     | 加什么                               | 登记方式                     |
| ---------- | ------------------------------------ | ---------------------------- |
| Panel      | 左侧栏里的一个区块                   | `ctx.panels.register`        |
| Surface    | 右侧面板（Workbench）里的一种标签    | `ctx.surfaces.register`      |
| 设置页     | 设置里的一页                         | `ctx.settingsPages.register` |
| Command    | 命令面板与输入框 `/` 共用的一个操作  | `ctx.commands.register`      |
| 工具渲染器 | 一类工具调用在对话时间线里的显示方式 | `ctx.toolRenderers.register` |

除此之外没有别的登记途径。manifest 里写 `contributes.settings`、`contributes.commands`、
`contributes.slots` 或 `contributes.rpc` 会让整个插件不可用：安装时被拒绝；已经安装的插件升级后在插件页显示错误，
Host 入口和界面代码都不加载。把这些字段删掉，改用上表的登记函数。`contributes` 只读取 `agent`
（见 [Agent 插件](#agent-插件)），其它键作为插件自己的元数据原样保留。

`ctx.slots` 已经删除。还在调用它的插件会在 `apply` 里抛错（`Cannot read properties of undefined`），
错误显示在插件页；改用 `ctx.panels.register`、`ctx.surfaces.register` 或 `ctx.settingsPages.register`。

### Panel、Surface、设置页与 Command

UI 插件在五个扩展点上登记内容：Panel 是左侧栏里的一个区块，Surface 是右侧面板（Workbench）里的一种标签，
设置页是设置里的一页，Command 是命令面板与输入框 `/` 共用的一个操作，工具渲染器见[下文](#工具渲染器)。
内置功能也通过同一个扩展点注册表登记（浏览器、终端、文件、Diff、PR、检查点都是内置的 Surface；通用、外观、Agent
是内置的设置页，定时任务和插件是和聊天并列的页面；新会话、侧栏、右侧面板、设置、插件、添加项目都是内置的命令；命令、读文件、改文件、
搜索、抓取、提问、技能、后台任务、计划、MCP、浏览器的显示都是内置的工具渲染器），遵守同样的规则：

- `ctx.panels.register(panel)`、`ctx.surfaces.register(surface)`、`ctx.settingsPages.register(page)`、`ctx.toolRenderers.register(renderer)` 返回注销函数。
  登记的归属由宿主按插件自动填写，插件不需要也不能自己指定。
- `id` 在同一个扩展点上唯一，内置的 Surface 和设置页（`general`、`appearance`、`agents`）
  也算在内。和已有的 id 重名时，这次登记不生效、返回一个什么也不做的
  注销函数，先登记的一方保持不变；插件页里这个插件的状态是「有冲突」，详情里写明扩展点、id 和先登记的一方。
- 可选的 `order` 决定排列顺序（小的在前，缺省 0），相同时按 `id` 排。插件的 Surface 列在启动器和「+」菜单的
  「插件」组里；插件的设置页列在设置侧栏内置页后面的「插件设置」组里，设置里的搜索也会搜到它的名称。
- `file` 是文件标签的种类，Surface 不能用这个 id；用了按和工作台冲突处理。
- 插件停用或卸载时，它登记的全部 Contribution 一起移除（没有自己注销的也一样）；各个会话里已经打开的
  这种 Surface 标签随之关闭，当前标签改选相邻的标签；正在看它的设置页时回到通用页，前进后退也会跳过这一页。被它挤掉过同名登记的插件会重新应用一次，拿到空出来的 id。
- 插件更新到新版本时，新版本加载完才替换旧版本，已经打开的 Surface 标签保留，正在看的设置页也不变。
  这要求在 `apply` 里同步登记：`await` 之后才登记的话，新版本登记之前那一刻这一页不存在，正在看它的用户会
  回到通用页。其余插件的界面不动。
- `id`、`title` 不是字符串，或者没有给合法的 `Component`（包括还在用已删除的 `render`），
  `register` 直接抛错，插件页把它显示成界面代码错误。
- client bundle 没有加载成功时，插件页显示「加载失败」和原因；下一次重新加载插件时会再试。

```tsx
import { useState } from "react"
import {
  Badge,
  ListRow,
  SettingRow,
  SettingSection,
  Switch,
  useTheme,
} from "@pigcode/ui-primitives"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"

function DemoContent() {
  const theme = useTheme()
  const [verbose, setVerbose] = useState(false)
  return (
    <>
      <ListRow title="主题" meta={<Badge variant="primary">{theme}</Badge>} />
      <Switch checked={verbose} onCheckedChange={setVerbose} aria-label="详细日志" />
    </>
  )
}

function DemoSurface() {
  return (
    <SettingSection title="状态">
      <SettingRow title="主题">
        <Badge variant="primary">{useTheme()}</Badge>
      </SettingRow>
    </SettingSection>
  )
}

export function apply(ctx: ClientPluginContext): () => void {
  // 侧栏：标题由宿主画成和「项目」一样的分组标题，点击可以收起。
  const disposePanel = ctx.panels.register({
    id: "demo-panel",
    title: "Demo",
    Component: DemoContent,
  })
  // 右侧面板：出现在启动器和「+」菜单的「插件」组里，打开后是和文件、终端一样的标签。
  const disposeSurface = ctx.surfaces.register({
    id: "demo-inspector",
    title: "Demo Inspector",
    description: "启动器里悬停显示的一句说明",
    Component: DemoSurface,
  })
  // 设置：出现在设置侧栏的「插件设置」组里；宿主画页面标题（就是 title），插件画标题下面的内容。
  const disposeSettings = ctx.settingsPages.register({
    id: "demo-settings",
    title: "Demo",
    Component: DemoContent,
  })
  return () => {
    disposePanel()
    disposeSurface()
    disposeSettings()
  }
}
```

- 组件挂载在 `[data-plugin-content]` 容器里，外层只有这个挂载点的排版：宽度由挂载点决定，内边距来自侧栏、右栏、
  设置页各自的容器，插件没有专用内边距。容器没有插件的专用样式类，字体、颜色、行高都来自宿主，卡片、分组、列表行、
  按钮和空状态一律用 `@pigcode/ui-primitives` 的组件。

### Command：命令面板与输入框 `/`

`ctx.commands.register(command)` 登记的 Command 同时出现在命令面板（⌘K）和输入框的 `/` 建议里；两处执行的是
同一个 `run`。内置的新会话、侧栏、右侧面板、设置、插件、添加项目也是这么登记的，插件的和它们走同一条路：

- `id` 在全部命令里唯一（包括内置命令）。重名时按扩展点的规则拒绝，先登记的一方保留。
- `title` 是命令面板和 `/` 建议里的名称；`keywords` 是额外的搜索词。可选的 `order` 决定命令面板里的顺序
  （小的在前，缺省 0），相同时按 `id` 排。内置命令的 `order` 都小于 0，所以插件命令缺省排在它们后面，
  空的命令面板里按回车执行的仍然是新会话。
- `slash` 是 `/` 的触发名，例如 `slash: "debug"` 对应输入框里的 `/debug`，不能含空格和 `/`。不给 `slash` 的
  命令只出现在命令面板，例如设置、插件这类入口。`/` 名字不分大小写；重名时 `/` 建议里只显示排在前面的一条
  （内置命令总在前面，`/new`、`/panel` 已被占用），控制台会有一条警告，命令本身照常出现在命令面板里。
  输入框自己的 `/model`、`/plan`、`/ask`、`/readonly` 依赖输入框当前的 agent 与权限状态，不是 Command，
  也不出现在命令面板；它们同样排在插件命令前面。
- `icon` 是命令面板里的图标名（宿主图标表里的名字），缺省或不认识时用通用的闪电图标；`shortcut` 只是显示用的提示
  （例如 `Mod+n`），快捷键本身由宿主注册，插件登记它不会真的绑定按键。
- `available()` 返回 false 时两处都不列出这条命令，例如依赖的开发服务器没有启动。它在每次打开命令面板、
  `/` 建议每次更新（每敲一个字）时调用，要快，不能有副作用。
- 插件停用或卸载时命令一并移除，命令面板和 `/` 里同时消失。`id`、`title` 不是非空字符串、`run` 不是函数、
  `slash` 不合规时，`register` 直接抛错，插件页把它显示成界面代码错误。
- `run` 或 `available` 抛出的错误（包括 `run` 返回的 Promise 被拒绝）不会影响宿主，插件页在这个插件的行里列出
  命令执行出错，插件状态不变成加载失败；`available` 出错时这条命令按不能执行处理。

```ts
const disposeCommand = ctx.commands.register({
  id: "demo-run",
  title: "运行示例命令",
  keywords: ["调试", "debug"],
  icon: "spark",
  slash: "demo",
  run() {
    console.info("demo command ran")
  },
})
return () => disposeCommand()
```

### 工具渲染器

`ctx.toolRenderers.register(renderer)` 决定一类工具调用在对话时间线里怎么显示，主时间线和子 agent 的标签页都生效。
完整示例见 [`examples/capability-clock/client.tsx`](../examples/capability-clock/client.tsx)：它是带界面代码的
Capability 插件，`package.json` 里同时声明 `host` 和 `client`。内容是一个 React 组件，用 `Component` 传；
`render(container, call)` 这个 DOM 写法已删除，还在传的插件在登记时抛错。

```tsx
import { useLocale } from "@pigcode/ui-primitives"
import type { ClientPluginContext, ClientToolCall } from "@pigcode/plugin-sdk"

/** 组件收到这次调用；调用的状态、输入或输出变化时宿主用新的 tool 重画。 */
function ClockNow({ tool }: { tool: ClientToolCall }) {
  const { locale } = useLocale()
  return <p className="hint">{`${locale}: ${tool.status} ${tool.output ?? ""}`}</p>
}

const dispose = ctx.toolRenderers.register({
  id: "clock-now",
  tools: ["clock_now"],
  Component: ClockNow,
})
```

**匹配是声明式的。** `tools` 和 `families` 至少给一个非空的，两者是「或」的关系。宿主只比较名字，时间线渲染时不运行
插件的代码，所以没有 `matches` 这样的回调：

- `tools` 里的名字匹配完整的工具名，或者 `mcp__<服务>__<工具>` 里的工具部分，区分大小写，不做前缀或模糊匹配。写工具
  注册时的名字（`clock_now`）就够了：`ctx.mcp.registerTool` 注册的工具，Claude Code 和 Codex 在时间线里都报告成
  `mcp__pigcode__clock_now`，这个前缀由宿主和 Agent 决定，插件不需要知道。Agent 可能改写工具名里的特殊字符（例如
  `foo.bar`），工具名只用字母、数字、`_` 和 `-` 最稳妥。名字不分服务：`tools: ["search"]` 也会匹配
  `mcp__github__search`，只想要某一个服务时写完整的 `mcp__github__search`。
- `families` 是工具族（类型 `ClientToolFamily`）：宿主把各 Agent 的工具名统一到一个族，例如 Bash 和 `exec_command`
  都是 `shell`。可选的值是 `file-read`、`file-write`、`shell`、`search`、`web-fetch`、`todo`、`ask-user-question`、`agent`、
  `skill`、`task-output`、`task-stop`、`message`、`plan-guidance`、`switch-mode`、`mcp`、`browser`、`unknown`。`mcp` 匹配
  所有 MCP 工具，除了 `browser_*` 这些算 `browser` 族；`unknown` 匹配宿主不认识的全部工具，也就是替换通用渲染器，
  一般用不上。

**优先级就是 `order`。** 扩展点上的渲染器按 `order` 从小到大排（相同时按 `id`），第一个匹配的生效；没有匹配时用通用
渲染器（工具名加可展开的参数与结果）。内置渲染器的 `order` 都是 1000，插件缺省是 0，所以插件的渲染器优先于内置的：
内置的 MCP 渲染器匹配所有 `mcp__` 工具，`order` 大于 1000 的插件渲染器永远排不到它前面。

按族匹配的渲染器要自己给一个 `order`，不要留在缺省的 0：和别的插件同为 0 时只能按 `id` 决出先后，结果和名字相关。
一般用 1 到 999，这样按工具名登记的渲染器（缺省 0）仍然优先，又排在所有内置渲染器前面；想接管 `unknown` 的用
大于 1000 的。正好等于 1000 时按 `id` 和内置渲染器决胜负，不要用。

**内容是 React 组件。** 传 `Component`，组件收到这次调用 `tool`：

- `tool` 有 `id`、`name`、`status`（`running`、`completed`、`failed`、`stopped`）、`input`、`output`（文字形式，还没有时是
  `undefined`）、`inputValue`、`outputValue`（事件里原样的值，形状由 Agent 决定，比如同一个 MCP 工具的结果可能是 JSON
  文字，也可能是内容块数组）、`startedAt`、`endedAt`、`exitCode`。
- 调用的状态、输入或输出变化时，宿主用新的 `tool` 重画；其余时候不重画，组件自己的状态保留。
- 渲染抛错时，错误显示在这一行里（由错误边界接住），不影响时间线的其余部分。
- 运行中的命令，流出来的输出不传给插件渲染器，`tool.output` 要等调用结束才有内容；内置的命令行会实时显示。
- 插件停用或卸载时渲染器一起移除，已经显示的调用立即回到内置渲染器（`mcp__` 工具是内置的 MCP 行）或通用渲染器。

**合并分组。** 连续的读文件、搜索、网页抓取和只读命令合成「查阅」，连续的终端命令合成「终端」，连续的浏览器操作合成
「浏览器」。
这一步按工具族进行，先于渲染器：分组的标题行总是宿主画的，插件的渲染器只用在展开后的子项上。下面这些工具不经过工具渲染器：
`todo`（显示在状态面板）、`plan-guidance`（不显示）、有子 agent 卡片的 `agent` 调用，以及已经显示成提问卡片的
`ask-user-question` 调用。

`id` 冲突、抛错和清理的规则与其它扩展点相同；内置渲染器的 `id` 是 `builtin.<族名>`。`id`、`order`、`tools`、`families`
不合规，没有给合法的 `Component`（包括还在用已删除的 `render`），或者 `tools` 和 `families` 都是空的，`register` 直接抛错，
插件页把它显示成界面代码错误。

### 宿主的主题与语言

React 组件里用 `useTheme()` 和 `useLocale()`，见 [使用宿主的 React](#使用宿主的-react)。不在组件里时用：

- `ctx.theme.get()` 返回 `"light"` 或 `"dark"`，`ctx.theme.subscribe(listener)` 在切换时通知，返回取消订阅函数。
- `ctx.locale.get()` 返回界面语言（`zh-CN`、`en-US`），`ctx.locale.subscribe` 同上。插件的文案自己按语言选择。

### 自己写样式

插件没有自己的样式工具包，也没有 `pg-*` 类或 `--pg-*` 变量：界面用 `@pigcode/ui-primitives` 的组件搭，
颜色、圆角、间距和字号都跟着宿主的设计 token 走。确实要写一小段样式时，用宿主 token 的同名 CSS 变量
（`var(--fg)`、`var(--muted)`、`var(--space-4)`、`var(--r-md)` 等，见 `packages/ui-primitives/src/styles/tokens.css`），
不要写死颜色。

### 调用 Host

`ctx.host.call(method, params)` 通过现有 MessagePort RPC 调用 Host，不引入 HTTP/WebSocket/token。

UI 插件运行在渲染进程，不应访问 Node 或 Electron API。

## 启停与冲突规则

启用和停用都是热生效，不需要重启应用：

1. 启用时先计算“当前已启用插件 + 目标插件”的 `provides`。只要有一个服务标识被多个插件声明
   （包括同一插件重复声明），就抛出 `PROVIDES_CONFLICT`，附带冲突的标识和插件 id，并拒绝启用。
2. 安装和启动时同样检查 `provides`：先加载的插件保留，后加载的插件不加载 Host 入口与界面代码，
   列表里标记为冲突并说明冲突的标识和先加载的插件。停用或卸载先加载的那个之后，后一个自动接上。
3. 检查通过后，Host 入口被动态挂载，agent 与 Capability 插件的服务立即可用。
4. boot graph 立即重写；渲染进程加载新出现的 UI client bundle，它的 Panel、Surface、设置页、Command 与工具渲染器出现。
   出错（`provides` 冲突、`engines`/`apiVersion` 不兼容、Host 入口 import 或 apply 失败）的插件不写进 boot graph。
5. 停用时会卸载 Host 入口并等待 `ctx.effect` 清理，agent 与 Capability 插件的服务立即消失；
   boot graph 重写后，它的 Panel、Surface、设置页、Command 与工具渲染器也会移除，已经打开的 Surface 标签关闭，
   正在看的设置页回到通用页，时间线回到内置或通用的显示。停用 agent 还会取消它排队中的 run、
   中断运行中的 run 并释放会话。

因此插件必须正确清理自己注册的东西：agent 用
`ctx.effect(() => () => ctx.agents.unregister(id))`，UI 插件返回 `apply` 的清理函数。
`apiVersion` 或 `engines.pigcode` 不兼容的插件不会被 Host 加载，列表里会显示错误原因，
其中 `apiVersion` 不兼容的错误写明插件需要的版本和当前 Host 支持的版本。
Host 入口 import 或 apply 抛错时 Host 照常启动，错误显示在插件页，这个插件的界面代码也不加载。
插件页的「刷新」会重新对一遍：把插件文件修好并重新安装后，刷新就能重新加载，不用停用再启用或重启。

## 安装与卸载

桌面端有两个入口，背后是同一套安装流程：

- **设置 → Agent → 安装 agent**：安装 Agent 插件，可以用“选择文件夹…”挑本地目录。
- **侧栏的插件**：页面分「插件市场」和「已安装」两段。标题栏的「添加」里有三项：
  - **创建插件**：让 agent 写一个插件，见[让 agent 创建插件](#让-agent-创建插件)。
  - **添加插件市场**：添加一个插件市场，见[插件市场](#插件市场)。
  - **安装插件**：直接安装一个插件，填的内容见下文，也可以用“选择文件夹…”。

  已安装的插件按类型分组，每组两列卡片：开关启停，插件有设置页时卡片上有「打开」，点卡片看包名、权限、来源、更新与卸载。

「安装插件」可以填的内容：

- GitHub 仓库：`owner/repo`、`owner/repo#v1.2.0`（分支、标签或提交）、`owner/repo/packages/clock`（仓库里的子目录）、
  `github:owner/repo`，或者从网页复制的 `https://github.com/owner/repo/tree/main/packages/clock`、`…/releases/tag/v1.2.0`。
  Host 直接下载 GitHub 的 tar.gz 归档并在进程里解开，不需要系统里装 git 或 pnpm；环境变量 `GITHUB_TOKEN` / `GH_TOKEN`
  有值时会带上令牌（私有仓库、避开匿名限流）。仓库里装的是构建好的插件（ADR 0006）：入口要指向 `.js`。
- 其他 git 仓库：`git@github.com:owner/repo.git`、`git+https://git.example.com/team/tools.git`、`ssh://…`，可以用 `#ref` 指定分支。
  这些交给系统 git 浅克隆，适合私有仓库和自建服务。
- https 上的 tar.gz：例如 `https://example.com/pigcode-clock-1.0.0.tgz`（npm pack 的格式也认）。
- 本地目录：绝对路径（例如 `/tmp/pigcode-plugin-demo` 或 `C:\plugins\demo`）、`./` 开头的相对路径
  或 `file:` 前缀。Host 把目录复制到用户 profile 的 `node_modules/<包名>`，插件源目录保持不变（`.git` 不复制）。
- npm：包名、版本或本地 tarball，例如 `my-pigcode-plugin@1.0.0` 或 `/tmp/pkg.tgz`；
  Host 通过 `pnpm add` 安装到用户 profile，需要用户机器上有 pnpm。

下载的内容在临时目录里解开（归档最大 50 MB，解开最大 200 MB；符号链接跳过，路径跳出目录的归档直接拒绝），
再和本地目录一样复制进 profile。填的是一个插件市场（有 `marketplace.json`、没有插件的 `package.json`）时，
安装会提示改用「添加插件市场」。

装好的插件立即启用，`plugins.yml` 里记下它从哪里装的。**更新**按这个来源重新安装，保留插件的配置和启停状态：
从远程插件市场装的先刷新市场、拿最新的条目；从 GitHub、git、网址或本地目录装的重新下载或复制一遍。
旧版本装的插件没有来源记录，重新安装一次就能更新。

两个页面都可以卸载用户安装的插件（RPC `plugin.uninstall`，参数 `{ "id": … }`）：
Host 先卸下插件的 Host 入口并等待 `ctx.effect` 清理，再删除 `node_modules` 里的包和列表里的记录。
agent 的设置值保留在 `settings.json` 里，重新安装后还在。内置插件不能卸载，
对它们调用 `plugin.uninstall` 会得到 `PLUGIN_BUILTIN` 错误。

对应的 Host RPC：

| 方法                            | 参数                           | 说明                                                                |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------- |
| `plugin.install`                | `{ "spec": "owner/repo" }`     | 上面任何一种写法                                                    |
| `plugin.installLocal`           | `{ "sourceDir": "/abs/path" }` | 只装本地目录                                                        |
| `plugin.installFromMarketplace` | `{ "marketplace", "name" }`    | 安装插件市场里的一项，装好的包名必须和条目一致                      |
| `plugin.update`                 | `{ "id": "capability.x" }`     | 按来源重新安装                                                      |
| `marketplace.list`              | `{}`                           | 已添加的市场与其中的插件                                            |
| `marketplace.add`               | `{ "source": "owner/repo" }`   | 添加市场，来源的写法见下文                                          |
| `marketplace.refresh`           | `{ "id"?: "acme-tools" }`      | 刷新一个市场，不给 id 时刷新全部启用的市场；失败的原因在 `error` 里 |
| `marketplace.setEnabled`        | `{ "id", "enabled": false }`   | 启用或停用市场，停用的不列出、不刷新，从它装的插件保留              |
| `marketplace.remove`            | `{ "id": "acme-tools" }`       | 删除市场，从它装的插件保留                                          |

安装的插件和启停状态记在用户 profile 目录的 `plugins.yml` 里，已添加的市场记在 `marketplaces.json` 里；
内置插件只记录是否停用。用户 profile 默认在 Electron `userData` 下的 `profiles/desktop`，可以用环境变量 `PIGCODE_PROFILE_DIR`
指定。

安装前请确认插件来源可信：安装界面会展示 `permissions` 声明和“插件以 Host 权限运行”的风险提示，添加插件市场前
必须勾选风险确认。权限声明目前只用于展示，不会限制插件能做的事。

## 插件市场

插件市场是一个列出插件的目录文件，放在 `.pigcode-plugin/marketplace.json`，或者市场根目录的 `marketplace.json`：

```json
{
  "name": "acme-tools",
  "displayName": "Acme 团队插件",
  "description": "团队内部用的 Pigcode 插件",
  "owner": { "name": "Acme", "url": "https://github.com/acme" },
  "plugins": [
    {
      "name": "pigcode-clock",
      "source": "./plugins/clock",
      "displayName": "时钟",
      "description": "给 agent 一个读取当前时间的 MCP 工具",
      "version": "0.2.0",
      "category": "productivity",
      "icon": "./plugins/clock/icon.png",
      "homepage": "https://example.com/clock",
      "author": { "name": "Acme" }
    },
    {
      "name": "pigcode-jira",
      "source": { "source": "github", "repo": "acme/pigcode-jira", "ref": "v1.0.0" }
    },
    {
      "name": "pigcode-notes",
      "source": { "source": "npm", "package": "pigcode-notes", "version": "^2.0.0" }
    },
    {
      "name": "pigcode-board",
      "source": {
        "source": "url",
        "url": "https://example.com/pigcode-board-1.0.0.tgz",
        "sha256": "…"
      }
    }
  ]
}
```

- `name` 是市场的 id：小写字母、数字、`.`、`_`、`-`，同一个 id 只能来自一个来源。
- 每个条目的 `name` 是插件的包名，安装后会核对 `package.json` 的 `name`，不一致时拒绝安装。
- `source`：`./相对路径`（从市场根目录算起，不能跳出去），`{ "source": "github", "repo", "ref"?, "path"? }`，
  `{ "source": "git", "url", "ref"?, "path"? }`，`{ "source": "npm", "package", "version"? }`，
  `{ "source": "url", "url", "sha256"? }`（https 上的 tar.gz，给了 sha256 就校验）。格式不对的条目不显示。
- `displayName`、`description`、`version`、`category`、`author`、`homepage`（https）都是可选的展示信息；`version` 用来判断
  已安装的插件能不能更新。`icon` 可以是 https 地址，也可以是市场里的图片（png、jpg、svg、webp，256 KB 以内）。

「添加插件市场」可以填：GitHub 仓库（`owner/repo`、网页地址，可以带分支和子目录，例如
`https://github.com/acme/tools/tree/main/plugins`）、git 地址、https 上的 `marketplace.json`，或者本地文件夹与 `.json` 文件的绝对路径。
远程来源添加和刷新时下载一次，缓存在 profile 的 `marketplaces/<id>/` 里，安装从缓存里拿；刷新失败时保留上一次的内容，
原因显示在市场的组头和「市场源」里。本地文件夹每次直接读，改了插件源码刷新一下就能看到。
https 上的 `marketplace.json` 没有根目录，里面的插件只能用 GitHub、git、npm 或网址来源。

Claude Code 的插件市场（`.claude-plugin/marketplace.json`）里是 Claude Code 插件，格式不同，添加时会说明原因。

插件页标题栏的「市场源」管理已添加的市场：每个市场源一行，写着来源、插件数、装了几个和更新时间，可以启停、刷新、
在浏览器里打开（GitHub、https 来源）或在文件夹中显示（本地来源）、复制来源地址和删除，上面还有「全部刷新」和「添加市场源」。
插件市场里每组标题旁的「⋯」也有刷新、停用和打开来源。停用的市场源不在插件市场里列出，不随「全部刷新」刷新，也不提示
从它装的插件有更新，这些插件照常可用；`marketplaces.json` 里只给停用的市场记 `"enabled": false`，再添加一次同一个来源会重新启用它。

## 让 agent 创建插件

插件页的「添加 → 创建插件」进入新会话草稿（放在最近用的项目里，没有项目时提示先添加项目）：输入框里预填「帮我创建一个 Pigcode 插件：」，
上方附上 Pigcode 插件创建指南，光标停在末尾，用户写下想要的插件再发送，不会自动发送。指南让 agent：

- 把插件写在项目的 `plugins/<slug>/`，用纯 JavaScript（ES module），不用 TypeScript、JSX、构建步骤和第三方依赖，
  这样打包后的应用也能直接安装；界面用宿主的 `react` 与 `@pigcode/ui-primitives`；
- 同时写好 `plugins/.pigcode-plugin/marketplace.json`；
- 不替用户安装，写完告诉用户：在插件页「添加 → 添加插件市场」填 `plugins/` 的绝对路径，再在插件市场里安装；
  以后改了插件，把 `version` 加一，在「市场源」里刷新，再点「更新」。

## 脚手架

在 `frontend/` 下运行：

```bash
pnpm create-plugin <dir> <kind> <name>
# 等价于
node scripts/create-plugin.ts <dir> <kind> <name>
```

- `kind`：`agent`、`capability` 或 `ui`。
- `name`：小写字母开头的插件标识，可含数字、点、下划线、连字符。
- `dir`：目标目录，不存在时创建；若已有同名文件且内容不同，脚本会拒绝覆盖。

示例：

```bash
pnpm create-plugin /tmp/pigcode-plugin-demo ui demo
```

生成结果：

```text
/tmp/pigcode-plugin-demo/
├── package.json   # name: pigcode-ui-demo，pigcode.client 指向 client.tsx
├── client.tsx     # React 插件：侧栏 Panel、右栏 Surface、设置页与一条 Command
├── build.ts       # 打包脚本（esbuild，宿主的共享模块标为 external）
├── env.d.ts      # 插件自带的全局类型补充（window、import.meta、?raw）
└── tsconfig.json  # tsc --noEmit 检查 client.tsx
```

`agent` 与 `capability` 会生成 `package.json` 和 `index.ts`：

- Agent 插件：`kind: "agent"`，`inject: ["agents"]`，`provides: ["agent:<name>"]`，
  `contributes.agent.id` 为 `<name>`；`index.ts` 在 `ctx.agents` 上注册一个带 `features` 的回显 driver。
- Capability 插件：服务名是插件标识的 camelCase（`session-info` → `sessionInfo`），
  `provides` 声明的就是它，`index.ts` 用同一个名字 `ctx.provide`。

`ui` 生成的是一个 React 插件，不需要先构建就能安装：入口是 `client.tsx`，安装时 Host 用 esbuild 编译它，
Panel、Surface、设置页都用宿主的 React 和 `@pigcode/ui-primitives`（`ListRow`、`Badge`、`Button`、`Switch`、
`SettingRow`、`SettingSection`、`useLocale`、`useTheme`）写，和宿主界面是同一套组件。`package.json` 的
`devDependencies` 里有 React、`@types/react`、TypeScript 和 esbuild：只为类型检查和打包，运行时拿到的是宿主的
那一份（ADR-0002）。两个 `@pigcode/*` 包没有发布到 npm，所以不写进依赖：直接安装源码目录不需要它们；要在仓库
里自己打包时才需要（用仓库根目录的 workspace 版本）。打包后把 `pigcode.client` 指向 `./dist/client.js`。

脚本结束时打印本地安装路径：
agent 填进 **设置 → Agent → 安装 agent**，其他插件填进侧栏 **插件** 页的“插件目录或 npm 包”。
