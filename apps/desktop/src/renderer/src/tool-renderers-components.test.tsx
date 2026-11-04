// @vitest-environment jsdom
/**
 * 工具渲染器的 React 写法（ADR-0002）：插件给 `Component`，组件由宿主的 React 渲染，调用变化时宿主用新的
 * `tool` 重画；组件自己的状态不因为无关的重渲染丢失；`Component` 与 `render` 必须二选一。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ExtensionRegistryScope,
  type ClientModule,
  type BootEntry,
  type ExtensionRegistry,
} from "@pigcode/client-runtime"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"
import { ToolBlock, type ToolCall } from "@pigcode/ui-chat"
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

/** 带内置渲染器的控制器，加载一个 apply 体为 body 的插件。 */
async function withPlugin(body: string) {
  const { extensions, controller } = setup()
  registerBuiltinToolRenderers(extensions)
  serve([entry("ui.demo", body)])
  await controller.reload()
  return { extensions, controller }
}

describe("tool renderers written as React components", () => {
  it("render a Component with the host's React, following the call", async () => {
    const seen: string[] = []
    const { extensions, controller } = setup(
      async () =>
        ({
          apply(ctx: ClientPluginContext) {
            // 组件只在渲染时拿到这次调用；调用变化时宿主用新的 tool 重画。
            ctx.toolRenderers.register({
              id: "component",
              tools: ["t"],
              Component: ({ tool }) => {
                seen.push(tool.status)
                return <p className="hint">{`component ${tool.status}`}</p>
              },
            })
          },
        }) as ClientModule,
    )
    registerBuiltinToolRenderers(extensions)
    serve([moduleEntry("ui.component")])
    await controller.reload()
    expect(controller.errors.get()).toEqual([])

    const first = call("t", { status: "running" })
    const tree = (tool: ToolCall) => timeline(extensions, <ToolBlock tool={tool} />)
    const { rerender, container } = render(tree(first))
    expect(screen.getByText("component running")).toBeTruthy()
    expect(container.querySelector("[data-plugin-content='component']")?.className).toBe(
      "pg-root pg-tool",
    )

    rerender(tree({ ...first, status: "completed", output: "done" }))
    expect(screen.getByText("component completed")).toBeTruthy()
    expect(seen).toEqual(["running", "completed"])
  })

  it("hold a Component's own state across re-renders that do not change the call", async () => {
    /** 组件里的 useState 用的是宿主的 React：点一下只重画这个组件，计数增加。 */
    function Counter({ tool }: { tool: ToolCall }) {
      const [count, setCount] = useState(0)
      return (
        <button type="button" onClick={() => setCount((value) => value + 1)}>
          {`${tool.status} ${count}`}
        </button>
      )
    }
    const { extensions, controller } = setup(
      async () =>
        ({
          apply(ctx: ClientPluginContext) {
            ctx.toolRenderers.register({ id: "counter", tools: ["t"], Component: Counter })
          },
        }) as ClientModule,
    )
    registerBuiltinToolRenderers(extensions)
    serve([moduleEntry("ui.counter")])
    await controller.reload()

    const first = call("t", { status: "completed" })
    const tree = (tool: ToolCall) => timeline(extensions, <ToolBlock tool={tool} />)
    const { rerender } = render(tree(first))
    fireEvent.click(screen.getByRole("button", { name: "completed 0" }))
    expect(screen.getByRole("button", { name: "completed 1" })).toBeTruthy()

    // 内容相同的新对象不算变化，组件自己的状态留着。
    rerender(tree({ ...first }))
    expect(screen.getByRole("button", { name: "completed 1" })).toBeTruthy()
  })

  it("reject a tool renderer that gives neither or both of Component and render", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const cases: Array<[string, string]> = [
      ["neither", `ctx.toolRenderers.register({ id: "bad", tools: ["t"] })`],
      [
        "both",
        `ctx.toolRenderers.register({
          id: "bad", tools: ["t"], render() {}, Component: ({ tool }) => tool.name,
        })`,
      ],
    ]
    for (const [, body] of cases) {
      const { extensions, controller } = await withPlugin(body)
      expect(controller.errors.get()).toMatchObject([
        {
          pluginId: "ui.demo",
          kind: "apply",
          detail: expect.stringContaining("give exactly one of render or Component"),
        },
      ])
      expect(extensions.get("toolRenderer").some((item) => item.id === "bad")).toBe(false)
    }
  })
})
