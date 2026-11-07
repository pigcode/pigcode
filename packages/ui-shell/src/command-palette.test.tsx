/** 验证命令面板：命令来自 Command 扩展点，过滤、键盘执行、分组与会话列表。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  ExtensionRegistryScope,
  createExtensionRegistry,
  type CommandContribution,
} from "@pigcode/client-runtime"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { CommandPalette } from "./command-palette"

afterEach(cleanup)

/** 一条内置命令；文案用语言包 key。 */
function command(
  id: string,
  title: CommandContribution["title"],
  run: () => void,
  extra: Partial<CommandContribution> = {},
): CommandContribution {
  return { id, owner: { kind: "builtin", id: "test" }, order: 0, title, run, ...extra }
}

/** 渲染一个打开的面板；命令先登记到扩展点注册表。 */
function renderPalette(
  overrides: Partial<Parameters<typeof CommandPalette>[0]> = {},
  commands: CommandContribution[] = [
    command("new-thread", { key: "nav.newThread" }, overrides.onNewThread ?? (() => {}), {
      shortcut: "Mod+n",
    }),
    command("plugins", { key: "settings.plugins" }, overrides.onClose ?? (() => {}), {
      keywords: ["插件"],
    }),
  ],
) {
  const registry = createExtensionRegistry()
  for (const item of commands) registry.register("command", item)
  const onClose = vi.fn()
  const onNewThread = vi.fn()
  render(
    <LocaleProvider locale="zh-CN">
      <ExtensionRegistryScope registry={registry}>
        <CommandPalette
          {...overrides}
          open
          onClose={overrides.onClose ?? onClose}
          projects={overrides.projects ?? []}
          threads={overrides.threads ?? []}
          activeThreadId={overrides.activeThreadId ?? null}
          onNewThread={overrides.onNewThread ?? onNewThread}
          onOpenThread={overrides.onOpenThread ?? (() => {})}
        />
      </ExtensionRegistryScope>
    </LocaleProvider>,
  )
  return { onClose, onNewThread }
}

describe("CommandPalette", () => {
  it("filters commands by label and runs the selected one", async () => {
    const user = userEvent.setup()
    const run = vi.fn()
    renderPalette({}, [command("plugins", { key: "settings.plugins" }, run)])

    await user.type(screen.getByLabelText("搜索或执行命令…"), "插件")
    const item = screen.getByRole("option", { name: /插件/ })
    await user.click(item)

    expect(run).toHaveBeenCalledTimes(1)
  })

  it("runs the first command on Enter", async () => {
    const user = userEvent.setup()
    const run = vi.fn()
    renderPalette({}, [command("new-thread", { key: "nav.newThread" }, run)])

    await user.keyboard("{Enter}")

    expect(run).toHaveBeenCalledTimes(1)
  })

  it("shows a shortcut hint from the command's shortcut field", () => {
    renderPalette({}, [
      command("new-thread", { key: "nav.newThread" }, () => {}, {
        shortcut: "Mod+n",
      }),
    ])

    expect(screen.getByRole("option", { name: /新会话/ }).textContent).toContain("N")
  })

  it("leaves out commands that are not available", () => {
    renderPalette({}, [
      command("hidden", { key: "nav.newThread" }, () => {}, { available: () => false }),
      command("shown", { key: "settings.plugins" }, () => {}),
    ])

    expect(screen.getAllByRole("option")).toHaveLength(1)
    expect(screen.getByRole("option", { name: /插件/ })).toBeTruthy()
  })

  it("asks available() again each time the palette opens", () => {
    let ready = false
    const registry = createExtensionRegistry()
    registry.register(
      "command",
      command("dev", { text: "Open the dev server" }, () => {}, { available: () => ready }),
    )
    const palette = (open: boolean) => (
      <LocaleProvider locale="zh-CN">
        <ExtensionRegistryScope registry={registry}>
          <CommandPalette
            open={open}
            onClose={() => {}}
            projects={[]}
            threads={[]}
            activeThreadId={null}
            onNewThread={() => {}}
            onOpenThread={() => {}}
          />
        </ExtensionRegistryScope>
      </LocaleProvider>
    )
    const { rerender } = render(palette(true))
    expect(screen.queryByRole("option", { name: /Open the dev server/ })).toBeNull()

    ready = true
    rerender(palette(false))
    rerender(palette(true))
    expect(screen.getByRole("option", { name: /Open the dev server/ })).toBeTruthy()
  })

  it("starts the new thread draft in the project picked from the projects group", async () => {
    const user = userEvent.setup()
    const onNewThread = vi.fn()
    renderPalette(
      {
        onNewThread,
        projects: [
          { id: "p1", name: "one", rootPath: "/one", createdAt: "2026-10-20T00:00:00.000Z" },
          { id: "p2", name: "two", rootPath: "/two", createdAt: "2026-10-20T00:00:00.000Z" },
        ],
      },
      [],
    )

    await user.click(screen.getByRole("option", { name: /two/ }))

    expect(onNewThread).toHaveBeenCalledWith("p2")
  })

  it("closes on Escape", async () => {
    const user = userEvent.setup()
    const { onClose } = renderPalette()

    await user.keyboard("{Escape}")

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("lists the same threads as the sidebar: no archived ones, none from removed projects", () => {
    const thread = (id: string, projectId: string, archivedAt: string | null = null) => ({
      id,
      projectId,
      title: `Thread ${id}`,
      defaultAgentId: "fake",
      lastAgentId: null,
      lastModelId: null,
      permissionMode: "workspace-write" as const,
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      archivedAt,
      lastRunId: null,
    })
    renderPalette({
      projects: [
        { id: "p1", name: "one", rootPath: "/one", createdAt: "2026-10-20T00:00:00.000Z" },
      ],
      threads: [
        thread("a", "p1"),
        thread("b", "p1", "2026-10-21T00:00:00.000Z"),
        thread("c", "gone"),
      ],
    })

    const labels = screen.getAllByRole("option").map((item) => item.textContent ?? "")
    expect(labels.some((label) => label.includes("Thread a"))).toBe(true)
    expect(labels.some((label) => label.includes("Thread b"))).toBe(false)
    expect(labels.some((label) => label.includes("Thread c"))).toBe(false)
  })
})
