// @vitest-environment jsdom
/**
 * 插件的工具渲染器：按声明的工具名或工具族匹配、优先于内置渲染器、按 order 排序，出错不影响时间线，
 * 停用后立即回到内置或通用的显示。插件只能登记 React 组件；还在传 `render` 的登记被拒绝。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ExtensionRegistryScope,
  type BootEntry,
  type ClientModule,
  type ExtensionRegistry,
} from "@pigcode/client-runtime"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"
import { CommandGroup, ToolBlock, type ToolCall } from "@pigcode/ui-chat"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { registerBuiltinToolRenderers, ToolRenderersScope } from "./builtin-tool-renderers"
import { entry, serve, setup } from "./client-plugins.fixtures"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function call(name: string, extra: Partial<ToolCall> = {}): ToolCall {
  return { id: `${name}-1`, name, status: "completed", input: "{}", output: undefined, ...extra }
}

function timeline(extensions: ExtensionRegistry, node: ReactNode) {
  return (
    <LocaleProvider locale="zh-CN">
      <ExtensionRegistryScope registry={extensions}>
        <ToolRenderersScope>{node}</ToolRenderersScope>
      </ExtensionRegistryScope>
    </LocaleProvider>
  )
}

/** 一次插件 apply 的 boot 条目，模块由测试直接给出。 */
const moduleEntry = (id: string): BootEntry => ({ id, revision: "1", inject: [], url: id })

describe("plugin tool renderers", () => {
  /**
   * 一段插件代码里的组件：组件直接返回文字（React 19 允许），boot 条目按普通 JS 解析，不能带 JSX。
   */
  const widget = (text: string) => `Component: () => ${JSON.stringify(text)}`

  /** 连工具名一起显示出来的组件，用来确认这一行走的是哪个渲染器。 */
  const named = (text: string) =>
    `Component: (props) => ${JSON.stringify(text)} + " " + props.tool.name`

  /** 带内置渲染器的控制器，加载一段用函数组件写的插件。 */
  async function withComponent(renderer: string) {
    const { extensions, controller } = setup()
    registerBuiltinToolRenderers(extensions)
    serve([entry("ui.demo", renderer)])
    await controller.reload()
    return { extensions, controller }
  }

  it("match by family and take priority over the built-in of that family", async () => {
    const { extensions, controller } = await withComponent(
      `ctx.toolRenderers.register({ id: "shells", families: ["shell"], ${named("plugin")} })`,
    )
    expect(controller.errors.get()).toEqual([])
    render(
      timeline(
        extensions,
        <>
          <ToolBlock tool={call("Bash")} />
          <ToolBlock tool={call("exec_command", { id: "x" })} />
          <ToolBlock tool={call("Read")} />
        </>,
      ),
    )
    expect(screen.getByText("plugin Bash")).toBeTruthy()
    expect(screen.getByText("plugin exec_command")).toBeTruthy()
    expect(screen.queryByText("plugin Read")).toBeNull()
  })

  it("lose to the built-in when their order is larger", async () => {
    const { extensions } = await withComponent(`ctx.toolRenderers.register({
      id: "late",
      order: 2000,
      families: ["mcp"],
      ${widget("late")},
    })`)
    render(timeline(extensions, <ToolBlock tool={call("mcp__github__list_issues")} />))
    expect(screen.queryByText("late")).toBeNull()
    expect(screen.getByRole("button", { name: /MCP/ })).toBeTruthy()
  })

  it("beat a family renderer at the same order only by id, so families should ask for their own order", async () => {
    // 审查发现的行为：同为 0 时按 id 排，和渲染器是按名字还是按族匹配无关。文档让按族匹配的用 1 到 999。
    const { extensions } = await withComponent(`
      ctx.toolRenderers.register({
        id: "a-family", families: ["mcp"],
        ${widget("family")},
      })
      ctx.toolRenderers.register({
        id: "clock-now", tools: ["clock_now"],
        ${widget("named")},
      })`)
    render(timeline(extensions, <ToolBlock tool={call("mcp__pigcode__clock_now")} />))
    expect(screen.getByText("family")).toBeTruthy()
  })

  it("let a named renderer at the default order beat a family one that follows the docs", async () => {
    const { extensions } = await withComponent(`
      ctx.toolRenderers.register({
        id: "a-family", order: 1, families: ["mcp"],
        ${widget("family")},
      })
      ctx.toolRenderers.register({
        id: "clock-now", tools: ["clock_now"],
        ${widget("named")},
      })`)
    render(timeline(extensions, <ToolBlock tool={call("mcp__pigcode__clock_now")} />))
    expect(screen.getByText("named")).toBeTruthy()
  })

  it("apply a plugin's family renderer to the children of an expanded command group", async () => {
    const { extensions } = await withComponent(
      `ctx.toolRenderers.register({ id: "shells", families: ["shell"], ${named("plugin")} })`,
    )
    const { container } = render(
      timeline(
        extensions,
        <CommandGroup tools={[call("Bash", { id: "a" }), call("Bash", { id: "b" })]} />,
      ),
    )
    // 分组标题行由宿主画；展开后子项走插件的渲染器。
    expect(container.querySelector("[data-plugin-content]")).toBeNull()
    await userEvent.click(container.querySelector(".cmd-group .tool-row-head")!)
    expect(screen.getAllByText("plugin Bash")).toHaveLength(2)
  })

  it("follow the plugin's order between themselves", async () => {
    const { extensions } = await withComponent(`
      ctx.toolRenderers.register({
        id: "a-second", order: 5, tools: ["t"],
        ${widget("second")},
      })
      ctx.toolRenderers.register({
        id: "z-first", order: 1, tools: ["t"],
        ${widget("first")},
      })`)
    render(timeline(extensions, <ToolBlock tool={call("t")} />))
    expect(screen.getByText("first")).toBeTruthy()
    expect(screen.queryByText("second")).toBeNull()
  })

  it("ignore later changes to the arrays the plugin passed", async () => {
    const { extensions } = await withComponent(`
      const tools = ["t"]
      ctx.toolRenderers.register({
        id: "r", tools,
        ${widget("plugin")},
      })
      tools.length = 0`)
    render(timeline(extensions, <ToolBlock tool={call("t")} />))
    expect(screen.getByText("plugin")).toBeTruthy()
  })

  it.each([
    ["no match at all", `Component: () => null`, "tools or families must list at least one name"],
    ["empty lists", `tools: [], families: [], Component: () => null`, "at least one name"],
    ["a non-array", `tools: "clock_now", Component: () => null`, "tools must be an array"],
    ["an empty name", `tools: [""], Component: () => null`, "tools must be an array"],
    [
      "an unknown family",
      `families: ["shells"], Component: () => null`,
      "families must be an array",
    ],
    ["no content", `tools: ["t"]`, "Component must be a React component"],
    ["a bad order", `tools: ["t"], order: "1", Component: () => null`, "order must be a number"],
  ])("reject %s as an apply error", async (_name, fields, message) => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { extensions, controller } = await withComponent(
      `ctx.toolRenderers.register({ id: "bad", ${fields} })`,
    )
    expect(controller.errors.get()).toMatchObject([
      { pluginId: "ui.demo", kind: "apply", detail: expect.stringContaining(message) },
    ])
    expect(extensions.get("toolRenderer").some((item) => item.id === "bad")).toBe(false)
  })

  it("rejects a renderer that still passes render, naming the replacement", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { extensions, controller } = await withComponent(
      `ctx.toolRenderers.register({ id: "bad", tools: ["t"], render(container) { container.textContent = "x" } })`,
    )
    expect(controller.errors.get()).toMatchObject([
      {
        pluginId: "ui.demo",
        kind: "apply",
        detail: expect.stringContaining(
          "render is no longer supported; pass the content as a React component in Component",
        ),
      },
    ])
    expect(extensions.get("toolRenderer").some((item) => item.id === "bad")).toBe(false)
  })

  it("reject a missing id as an apply error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { controller } = await withComponent(
      `ctx.toolRenderers.register({ tools: ["t"], Component: () => null })`,
    )
    expect(controller.errors.get()[0]?.detail).toContain("id must be a non-empty string")
  })

  it("follow the id conflict rule and report the conflict", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { extensions } = await withComponent(
      `ctx.toolRenderers.register({ id: "builtin.mcp", tools: ["t"], Component: () => null })`,
    )
    expect(extensions.conflicts()).toMatchObject([
      {
        point: "toolRenderer",
        id: "builtin.mcp",
        existing: { kind: "builtin" },
        rejected: { kind: "plugin", id: "ui.demo" },
      },
    ])
  })

  /** 登记一个测试直接给组件的渲染器。 */
  async function hosted(Component: (props: { tool: ToolCall }) => ReactNode) {
    const { extensions, controller } = setup(
      async () =>
        ({
          apply(ctx: ClientPluginContext) {
            ctx.toolRenderers.register({ id: "r", tools: ["t"], Component })
          },
        }) as ClientModule,
    )
    registerBuiltinToolRenderers(extensions)
    serve([moduleEntry("ui.direct")])
    await controller.reload()
    return { extensions, controller }
  }

  it("keep the component's state across re-renders that do not change the call", async () => {
    function Counter({ tool }: { tool: ToolCall }) {
      const [count, setCount] = useState(0)
      return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          {`${tool.status} ${count}`}
        </button>
      )
    }
    const { extensions } = await hosted(Counter)
    const first = call("t", { status: "running" })
    const tree = (tool: ToolCall) => timeline(extensions, <ToolBlock tool={tool} />)
    const { rerender } = render(tree(first))
    expect(screen.getByRole("button", { name: "running 0" })).toBeTruthy()

    // 内容相同的新对象（事件合并时常见）不打断组件自己的状态。
    rerender(tree({ ...first }))
    fireEvent.click(screen.getByRole("button", { name: "running 0" }))
    expect(screen.getByRole("button", { name: "running 1" })).toBeTruthy()

    // 调用变了：宿主换一个绑定新 tool 的组件，组件重新挂载，状态从 0 开始。
    rerender(tree({ ...first, status: "completed", output: "done" }))
    expect(screen.getByRole("button", { name: "completed 0" })).toBeTruthy()
  })

  it("keep a throwing renderer inside its row", async () => {
    const { extensions } = await hosted(() => {
      throw new Error("renderer exploded")
    })
    render(
      timeline(
        extensions,
        <>
          <ToolBlock tool={call("t")} />
          <ToolBlock tool={call("mcp__github__list_issues")} />
        </>,
      ),
    )
    expect(screen.getByText("renderer exploded").className).toBe("error-text")
    expect(screen.getByRole("button", { name: /MCP/ })).toBeTruthy()
  })
})
