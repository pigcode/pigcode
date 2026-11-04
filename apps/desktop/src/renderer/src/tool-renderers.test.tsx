// @vitest-environment jsdom
/**
 * 验证工具渲染器扩展点：内置渲染器按族登记；插件按声明的工具名或工具族匹配、优先于内置渲染器，
 * 调用变化时重画，出错不影响时间线，停用后立即回到内置或通用的显示。clock 样例用的是仓库里真实的 client.tsx。
 * 插件渲染器的匹配与排序规则见 tool-renderers-plugins.test.tsx。
 */
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ReactNode } from "react"
import type { ThreadEvent } from "@pigcode/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ExtensionRegistryScope,
  createExtensionRegistry,
  type BootEntry,
  type ClientModule,
  type ExtensionRegistry,
} from "@pigcode/client-runtime"
import { SubagentView, ToolBlock, type SubagentCall, type ToolCall } from "@pigcode/ui-chat"
import { LocaleProvider } from "@pigcode/ui-primitives"
import * as clockSample from "../../../../../examples/capability-clock/client"
import { registerBuiltinToolRenderers, ToolRenderersScope } from "./builtin-tool-renderers"
import { serve, setup } from "./client-plugins.fixtures"

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

describe("built-in tool renderers", () => {
  it("registers one renderer per family, all after the plugins' default order", () => {
    const extensions = createExtensionRegistry()
    registerBuiltinToolRenderers(extensions)
    const contributions = extensions.get("toolRenderer")
    expect(contributions.map((item) => item.id).sort()).toEqual(
      [
        "ask-user-question",
        "browser",
        "file-read",
        "file-write",
        "mcp",
        "search",
        "shell",
        "skill",
        "switch-mode",
        "task-output",
        "task-stop",
        "web-fetch",
      ].map((family) => `builtin.${family}`),
    )
    for (const item of contributions) {
      expect(item.order).toBe(1000)
      expect(item.owner).toEqual({ kind: "builtin", id: "toolRenderers" })
    }
  })

  it("shows each family with its row and everything else with the generic row", () => {
    const extensions = createExtensionRegistry()
    registerBuiltinToolRenderers(extensions)
    render(
      timeline(
        extensions,
        <>
          <ToolBlock tool={call("Bash", { input: '{"command":"true"}' })} />
          <ToolBlock tool={call("mcp__github__list_issues")} />
          <ToolBlock tool={call("frob_widget")} />
        </>,
      ),
    )
    expect(screen.getByRole("button", { name: /终端/ }).textContent).toContain("true")
    expect(screen.getByRole("button", { name: /MCP/ }).textContent).toBe("MCPGithub·List issues")
    expect(screen.getByText("Frob widget")).toBeTruthy()
  })

  it("gives the command row its live output", async () => {
    const extensions = createExtensionRegistry()
    registerBuiltinToolRenderers(extensions)
    const running = call("Bash", { status: "running", input: '{"command":"make"}' })
    render(timeline(extensions, <ToolBlock tool={running} live={"building\n"} />))
    const row = screen.getByRole("button", { name: /正在执行/ })
    if (row.getAttribute("aria-expanded") === "false") await userEvent.click(row)
    expect(screen.getByText("building")).toBeTruthy()
  })

  it("uses the built-in row of every family, and the generic row for the rest", () => {
    const extensions = createExtensionRegistry()
    registerBuiltinToolRenderers(extensions)
    // 每个族一个工具名，断言这一族的行自己的内容出现了（行组件都在同一个测试里解析，所以逐族断言）。
    const tools: ToolCall[] = [
      call("Bash", { input: '{"command":"pnpm lint"}' }),
      call("Read", { input: '{"file_path":"/p/src/index.ts"}' }),
      call("Edit", { input: '{"file_path":"/p/src/index.ts"}' }),
      call("Grep", { input: '{"pattern":"answer"}' }),
      call("WebFetch", { input: '{"url":"https://example.com"}' }),
      call("AskUserQuestion", { input: '{"questions":[]}' }),
      call("Skill", { input: '{"skill":"debug"}' }),
      call("TaskOutput", { input: '{"task_id":"t1"}' }),
      call("TaskStop", { input: '{"task_id":"t1"}' }),
      call("ExitPlanMode", { input: '{"plan":"Do it"}', inputValue: { plan: "Do it" } }),
      call("mcp__github__list_issues"),
      call("mcp__pigcode__browser_click", { input: '{"action":"click"}' }),
    ]
    const unknown = call("frob_widget")
    const { container } = render(
      timeline(
        extensions,
        <>
          {tools.map((tool) => (
            <ToolBlock key={tool.id} tool={tool} />
          ))}
          <ToolBlock tool={unknown} />
        </>,
      ),
    )
    expect(screen.getAllByText(/pnpm lint/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/index\.ts/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/answer/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/example\.com/).length).toBeGreaterThan(0)
    expect(screen.getByText("Do it")).toBeTruthy()
    expect(screen.getByRole("button", { name: /MCP/ }).textContent).toContain("List issues")
    // 浏览器行按动作显示「点击」；没有参数与结果时整行不是按钮。
    expect(screen.getByText("点击")).toBeTruthy()
    // 每一族都渲染出了自己的行，只有不认识的工具落到通用行。
    expect(container.querySelectorAll(".tool-row, .cmd-row, .plan-card").length).toBe(
      tools.length + 1,
    )
    expect(screen.getByText("Frob widget").className).toContain("tool-row-kind")
  })

  it("draws the plan card the same with or without the group's showIcon", () => {
    const extensions = createExtensionRegistry()
    registerBuiltinToolRenderers(extensions)
    const plan = call("ExitPlanMode", { input: '{"plan":"Do it"}', inputValue: { plan: "Do it" } })
    const drawn = (showIcon: boolean) => {
      const { container, unmount } = render(
        timeline(extensions, <ToolBlock tool={plan} showIcon={showIcon} />),
      )
      const html = container.innerHTML
      unmount()
      return html
    }
    expect(drawn(true)).toContain("Do it")
    expect(drawn(false)).toBe(drawn(true))
  })
})

describe("the clock sample's tool renderer", () => {
  async function clock() {
    const { extensions, controller } = setup(async () => clockSample as ClientModule)
    registerBuiltinToolRenderers(extensions)
    const graph = [moduleEntry("capability.pigcode-capability-clock")]
    serve(graph)
    await controller.reload()
    return { extensions, controller }
  }
  const NOW = '{"now":"2026-01-02T03:04:05.000Z"}'

  it("renders clock_now under both names, follows the call, and reverts when disabled", async () => {
    const { extensions, controller } = await clock()
    const bare = call("clock_now", { id: "bare", status: "running" })
    const mcp = call("mcp__pigcode__clock_now", { id: "mcp", output: NOW })
    const tree = (first: ToolCall) =>
      timeline(
        extensions,
        <>
          <ToolBlock tool={first} />
          <ToolBlock tool={mcp} />
        </>,
      )
    const { container, rerender } = render(tree(bare))
    const hosted = () => [...container.querySelectorAll("[data-plugin-content='clock-now']")]
    expect(hosted().map((node) => node.textContent)).toEqual([
      "正在读取时间",
      expect.stringContaining("当前时间"),
    ])
    expect(screen.queryByRole("button", { name: /MCP/ })).toBeNull()

    // 状态与输出变化时重画。
    rerender(tree({ ...bare, status: "completed", output: NOW }))
    expect(hosted()[0]?.textContent).toContain("当前时间")
    rerender(tree({ ...bare, status: "failed", output: "boom" }))
    expect(hosted()[0]?.textContent).toBe("读取时间失败")

    // 停用（从 boot graph 消失）后立即换回：不带前缀的名字用通用行，mcp__ 名字用内置的 MCP 行。
    serve([])
    await act(() => controller.reload())
    expect(hosted()).toEqual([])
    expect(screen.getAllByRole("button").map((row) => row.textContent)).toEqual([
      "Clock now执行失败",
      "MCPPigcode·Clock now",
    ])
  })

  it("does not touch other tools", async () => {
    const { extensions } = await clock()
    const { container } = render(
      timeline(
        extensions,
        <>
          <ToolBlock tool={call("mcp__pigcode__clock_nowish")} />
          <ToolBlock tool={call("clock_later")} />
        </>,
      ),
    )
    expect(container.querySelector("[data-plugin-content]")).toBeNull()
  })

  it("also applies in a sub-agent's tab", async () => {
    const { extensions } = await clock()
    const events: ThreadEvent[] = [
      {
        seq: 1,
        threadId: "t1",
        runId: "run_1",
        type: "tool.completed",
        payload: { toolCallId: "c1", name: "mcp__pigcode__clock_now", output: NOW },
        schemaVersion: 1,
        createdAt: "2026-10-21T08:00:00.000Z",
      } as ThreadEvent,
    ]
    const subagent: SubagentCall = { id: "s1", name: "Task", status: "completed", events }
    const { container } = render(timeline(extensions, <SubagentView subagent={subagent} />))
    expect(container.querySelector("[data-plugin-content='clock-now']")?.textContent).toContain(
      "当前时间",
    )
  })
})
