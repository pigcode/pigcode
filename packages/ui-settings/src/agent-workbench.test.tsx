/** 验证左边列表与右边设置的配合：列表里的未保存圆点、⌘S / Ctrl+S 快捷保存、模型搜索。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentSummary } from "@pigcode/contracts"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { AgentsPage } from "./agents-page"

afterEach(cleanup)

const CLAUDE: AgentSummary = {
  agentId: "claude",
  displayName: "Claude Code",
  pluginId: "agent.@pigcode/agent-claude",
  version: "0.1.0",
  builtin: true,
  enabled: true,
  registered: true,
  features: null,
  description: null,
  homepage: null,
  installHint: null,
  fields: [{ key: "launchArgs", type: "text", monospace: true, label: { "zh-CN": "启动参数" } }],
  customModels: true,
  values: {},
  error: null,
  instances: [
    {
      instanceId: "claude",
      agentId: "claude",
      label: "Claude Code",
      enabled: true,
      values: { launchArgs: "--default" },
      isDefault: true,
      createdAt: null,
    },
    {
      instanceId: "inst_work",
      agentId: "claude",
      label: "公司 API",
      enabled: true,
      values: { launchArgs: "--work" },
      isDefault: false,
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  ],
}

const noop = async () => undefined

describe("AgentsPage workbench interactions", () => {
  it("marks unsaved agents in the list and saves with Ctrl+S", async () => {
    const onSaveSettings = vi.fn(noop)
    render(
      <LocaleProvider locale="zh-CN">
        <AgentsPage
          agents={[CLAUDE]}
          defaultAgentId={null}
          statuses={{}}
          onDetect={noop}
          onSetEnabled={noop}
          onSaveSettings={onSaveSettings}
          onSetDefault={noop}
          onCreateInstance={async () => "new"}
          onUpdateInstance={noop}
          onRemoveInstance={noop}
        />
      </LocaleProvider>,
    )

    const row = (name: string) =>
      screen
        .getByRole("button", { name: `打开 ${name} 的设置` })
        .closest(".agent-item") as HTMLElement

    await userEvent.click(screen.getByRole("button", { name: "打开 公司 API 的设置" }))
    await userEvent.type(screen.getByRole("textbox", { name: "启动参数" }), " --fast")

    // 换到另一个 Agent 时，没保存的那一行名字旁边留一个圆点。
    await userEvent.click(screen.getByRole("button", { name: "打开 Claude Code 的设置" }))
    expect(within(row("公司 API")).getByLabelText("还没保存")).toBeTruthy()
    expect(within(row("Claude Code")).queryByLabelText("还没保存")).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "打开 公司 API 的设置" }))
    fireEvent.keyDown(window, { key: "s", ctrlKey: true })
    await waitFor(() =>
      expect(onSaveSettings).toHaveBeenCalledWith(
        expect.objectContaining({ agentId: "claude" }),
        expect.objectContaining({ instanceId: "inst_work" }),
        { launchArgs: "--work --fast" },
      ),
    )
  })

  it("filters large model lists without losing hidden state", async () => {
    const models = Array.from({ length: 7 }, (_, i) => ({
      id: `model-${i + 1}`,
      label: i === 5 ? "Claude Opus Special" : `Model ${i + 1}`,
    }))
    render(
      <LocaleProvider locale="zh-CN">
        <AgentsPage
          agents={[CLAUDE]}
          defaultAgentId={null}
          statuses={{}}
          models={{ claude: models }}
          onDetect={noop}
          onSetEnabled={noop}
          onSaveSettings={noop}
          onSetDefault={noop}
          onCreateInstance={async () => "new"}
          onUpdateInstance={noop}
          onRemoveInstance={noop}
        />
      </LocaleProvider>,
    )

    const search = screen.getByPlaceholderText("搜索模型")
    await userEvent.type(search, "Opus")
    const list = screen.getByRole("list", { name: "模型" })
    expect(within(list).getAllByRole("listitem")).toHaveLength(1)
    expect(list.textContent).toContain("Claude Opus Special")
  })
})
