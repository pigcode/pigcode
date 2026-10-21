# Pigcode 插件开发指南

Pigcode 插件就是普通的 npm 包：没有 `bundle-` 前缀，也没有第二套 manifest。
插件可以只提供 Host 代码、只提供 UI 代码，或两者都提供。本文覆盖最小可运行结构、
`package.json` 声明、provider / capability / UI 三类示例，以及安装、启停和冲突规则。

## 目录结构

一个最小的 Host 插件（provider 或 capability）：

```text
my-plugin/
├── package.json   # 唯一的 manifest：package.json 的 pigcode 字段
└── index.mjs      # Host 入口，在 Host 进程内运行
```

一个最小的 UI 插件：

```text
my-ui-plugin/
├── package.json   # pigcode.client 指向浏览器入口
└── client.mjs     # client bundle，在渲染进程的受限 facade 中运行
```

同时提供两类入口时，把 `index.mjs` 与 `client.mjs` 放在同一个包里，并在
`pigcode.host` 和 `pigcode.client` 中分别声明即可。

## package.json 的 pigcode 声明

```json
{
  "name": "pigcode-provider-echo",
  "version": "0.1.0",
  "type": "module",
  "main": "./index.mjs",
  "engines": {
    "pigcode": ">=0.1.0"
  },
  "pigcode": {
    "apiVersion": 1,
    "kind": "provider",
    "displayName": "Echo",
    "host": "./index.mjs",
    "client": "./client.mjs",
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
| `kind`            | 是   | `provider`、`capability`、`ui` 或 `bundle`。                           |
| `displayName`     | 否   | 插件管理界面展示的名称，缺省使用包名。                                 |
| `host`            | 否   | Host 入口的相对路径。`host` 与 `client` 至少要有一个。                 |
| `client`          | 否   | UI 入口的相对路径。                                                    |
| `inject`          | 否   | 依赖声明，默认 `[]`。Host 侧服务名如 `providers`、`sessions`。         |
| `provides`        | 否   | 提供的能力标识，默认 `[]`；用于启用时的冲突检测。                      |
| `contributes`     | 否   | 任意贡献点元数据，默认 `{}`；Host 原样透传给插件管理界面。             |
| `permissions`     | 否   | 权限声明，默认 `[]`；安装和列表界面会展示给用户。                      |
| `engines.pigcode` | 否   | semver 范围，按 Host 当前版本（`0.1.0`）校验；不满足时插件被标记错误。 |

补充说明：

- Host 入口模块还要 `export const inject = [...]`，Cordis 会等这些服务就绪后再调用
  `apply`。`package.json` 里的 `pigcode.inject` 是 manifest 声明，UI boot graph 也会携带它。
- `permissions` 目前是展示型声明，不做运行时授权或拦截；Host 插件始终以 Host 进程权限运行，
  所以安装时务必只选择可信来源。
- 兼容性不通过时，插件仍会显示在列表中并附带错误原因，但 Host 入口不会被加载。

## provider 插件

完整可运行示例见 [`examples/provider-echo`](../examples/provider-echo)；它把用户输入原样回显。
`package.json` 的 `pigcode` 部分：

```json
{
  "pigcode": {
    "apiVersion": 1,
    "kind": "provider",
    "displayName": "Echo",
    "host": "./index.mjs",
    "provides": ["provider:echo"],
    "permissions": [],
    "contributes": {
      "provider": {
        "id": "echo"
      }
    }
  }
}
```

`index.mjs` 导出 `apply(ctx)`，在 `ctx.providers` 上注册 driver：

```js
/** 示例 provider：把输入原样回显。 */
export const name = "provider-echo"
export const inject = ["providers"]

export function apply(ctx) {
  const driver = {
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
      return {
        id: `echo_${input.threadId}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: null,
        permissionMode: "workspace-write",
        model: null,
      }
    },
    async send(_session, input, runtime) {
      runtime.emit({ type: "run.started" })
      runtime.emit({ type: "message.delta", text: input.text })
      runtime.emit({ type: "message.completed", text: input.text })
      runtime.emit({ type: "run.completed" })
    },
    async interrupt() {},
    async dispose() {},
  }

  ctx.providers.register(driver)
  // 热停用时必须注销，否则 provider 仍会出现在切换列表里。
  ctx.effect(() => () => ctx.providers.unregister("echo"))
}
```

`send` 通过 `runtime.emit` 推送规范化事件，可用事件类型见
[`packages/contracts/src/events.ts`](../packages/contracts/src/events.ts) 中的 `ProviderEvent`。
需要审批时调用 `runtime.requestApproval`；取消通过 `runtime.signal` 观察。

第三方 provider 不要 `import` `@pigcode/host` 的内部路径。类型可以依赖
`@pigcode/plugin-sdk`（`ProviderPluginDriver` 等），运行时保持零依赖或只依赖自己的 npm 依赖。

## capability 插件

完整示例见 [`examples/capability-session-info`](../examples/capability-session-info)。
capability 通过 `ctx.provide` 暴露能力，使用只读的 `ctx.sessions`：

```js
/** 示例 capability：暴露当前线程的事件数量。 */
export const name = "capability-session-info"
export const inject = ["sessions"]

export function apply(ctx) {
  ctx.provide("sessionInfo", {
    count(threadId) {
      return ctx.sessions.read(threadId, 0).length
    },
  })
}
```

`ctx` 上可用的 Host 能力：

- `ctx.sessions.read(threadId, cursor)`：只读读取线程事件；需要 `inject: ["sessions"]`。
- `ctx.provide(name, value)`：注册一个供其他插件或 Host 使用的能力。
- `ctx.effect(setup)`：注册随插件卸载执行的清理逻辑。
- `ctx.providers.register` / `ctx.providers.unregister`：注册或移除 provider driver。
- `ctx.mcp.registerTool`：把工具暴露给 Claude / Codex 模型；需要 `inject: ["mcp"]`。

## 通过 MCP 暴露工具

capability 插件可以用 `ctx.mcp.registerTool` 注册工具；Host 会把它注入当前线程的
Claude 或 Codex 会话。完整示例见
[`examples/capability-clock`](../examples/capability-clock)：

```js
/** 示例 capability：通过 MCP 向模型暴露当前时间。 */
export const name = "capability-clock"
export const inject = ["mcp"]

export function apply(ctx) {
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
- `tool.name` 是模型看到的工具名；`inputSchema` 使用 JSON Schema，Host 会转换成
  对应 provider 需要的形状。返回值必须可 JSON 序列化。
- handler 的第二个参数是 `{ threadId }`，表示发起本次 run 的线程。工具注册表是
  Host 全局的，但每次调用都带线程作用域，因此并行会话不会共享可变调用状态。
- Claude 使用进程内 MCP server（`mcpServers.pigcode`）；Codex 使用 stdio bridge
  加 Unix domain socket / 命名管道，并在 hello 时用一次性 token 绑定线程。
  Host 不监听 TCP 端口。
- 没有任何已注册工具时，Host 不会注入空 MCP 配置。

## UI 插件

完整示例见 [`examples/ui-debug-panel`](../examples/ui-debug-panel)。UI 插件只拿到受限 facade：

```js
/** 侧栏 DOM 面板；不依赖 React。 */
export function apply(ctx) {
  return ctx.registerPanel({
    id: "demo-panel",
    title: "Demo Panel",
    render(container) {
      container.textContent = "Hello from my UI plugin"
    },
  })
}
```

`apply` 可以返回清理函数；`registerPanel` 本身也返回 disposer，返回它即可在停用时移除面板。

也可以向内置 slot 注册条目：

```js
export function apply(ctx) {
  const dispose = ctx.slots.register("settings.section", {
    id: "demo-settings",
    order: 20,
    // 返回值交给 React 渲染；纯 DOM 内容请用 registerPanel。
    render: (props) => `Demo section: ${props?.section ?? "general"}`,
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
- 第三方 client bundle 无法解析裸 `react` 导入，因此需要真实 DOM 面板时优先使用
  `ctx.registerPanel`；`ctx.slots.register` 适合返回字符串等 React 可渲染的原始值。
- `ctx.host.call(method, params)` 通过现有 MessagePort RPC 调用 Host，不引入 HTTP/WebSocket/token。

UI 插件运行在渲染进程，不应访问 Node 或 Electron API。

## 启停与冲突规则

启用和停用都是热生效，不需要重启应用：

1. 启用时先计算“当前已启用插件 + 目标插件”的 `provides`。只要有一个能力标识被多个插件声明
   （包括同一插件重复声明），就抛出 `PROVIDES_CONFLICT`，附带冲突能力和插件 id，并拒绝启用。
2. 检查通过后，Host 入口被动态挂载，provider / capability 立即可用。
3. boot graph 立即重写；渲染进程重新加载 UI client bundle，新插槽和面板出现。
4. 停用时会卸载 Host 入口并等待 `ctx.effect` 清理，provider / capability 立即消失；
   boot graph 重写后，对应的 UI 面板和 slot 条目也会移除。

因此插件必须正确清理自己注册的东西：provider 用
`ctx.effect(() => () => ctx.providers.unregister(id))`，UI 插件返回 `apply` 的清理函数。
`apiVersion` 或 `engines.pigcode` 不兼容的插件不会被 Host 加载，列表里会显示错误原因。

## 本地安装

桌面端路径：**设置 → 插件 → 插件目录或 npm 包**，然后点击“安装插件”。

- 本地目录：填入绝对路径（例如 `/tmp/pigcode-plugin-demo`），Host 会复制到 profile 的
  `node_modules/<包名>` 并立即启用。
- npm：填入包名、版本或 tarball，例如 `my-pigcode-plugin@1.0.0` 或 `/tmp/pkg.tgz`；
  Host 通过 `pnpm add` 安装到 profile。
- 对应的 Host RPC：本地目录用 `plugin.installLocal`，参数
  `{ "sourceDir": "/abs/path/to/plugin" }`；npm / tarball 用 `plugin.install`，参数
  `{ "spec": "my-pigcode-plugin@1.0.0" }`。

安装前请确认插件来源可信：安装界面会展示 `permissions` 声明和“插件以 Host 权限运行”的风险提示。
权限声明目前只用于展示，不会限制插件能力。

## 脚手架

在 `frontend/` 下运行：

```bash
pnpm create-plugin <dir> <kind> <name>
# 等价于
node scripts/create-plugin.mjs <dir> <kind> <name>
```

- `kind`：`provider`、`capability` 或 `ui`。
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
└── client.mjs     # 侧栏面板
```

provider / capability 会生成 `package.json` 和 `index.mjs`。脚本结束时打印本地安装路径，
把它填进桌面端的“插件目录或 npm 包”即可安装。
