/** 验证模型选择器：选中 agent 才列出它的模型、懒加载目录、跨 agent 切换、收藏与思考深度。 */
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { Composer } from "./composer"
import { resetComposerMemory } from "./composer-memory"
import type { ComposerAgent, ComposerModelCatalog } from "./composer-options"
import { resetModelPreferencesCache } from "./model-preferences"

const AGENTS: ComposerAgent[] = [
  { id: "claude", label: "Claude Code", installed: true },
  { id: "codex", label: "Codex", installed: false },
]

const CATALOG: ComposerModelCatalog = {
  claude: [
    {
      id: "opus",
      label: "Opus",
      isDefault: true,
      efforts: ["low", "medium", "high", "max"],
      defaultEffort: "high",
    },
    {
      id: "haiku",
      label: "Haiku",
      description: "最快",
      isDefault: false,
      efforts: [],
      defaultEffort: null,
    },
  ],
  codex: [
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      isDefault: true,
      efforts: ["minimal", "xhigh"],
      defaultEffort: "xhigh",
    },
  ],
}

beforeEach(() => {
  window.localStorage.clear()
  resetModelPreferencesCache()
})

afterEach(() => {
  cleanup()
  resetComposerMemory()
})

function renderPicker(props: Partial<ComponentProps<typeof Composer>> = {}) {
  const onSelectModel = vi.fn()
  const onSubmit = vi.fn()
  render(
    <LocaleProvider locale="zh-CN">
      <Composer
        onSubmit={onSubmit}
        onStop={() => {}}
        agents={AGENTS}
        agentId="claude"
        modelId="opus"
        catalog={CATALOG}
        onSelectModel={onSelectModel}
        {...props}
      />
    </LocaleProvider>,
  )
  return {
    onSelectModel,
    onSubmit,
    chip: () => screen.getByRole("button", { name: /Agent 与模型/ }),
  }
}

describe("ModelPicker", () => {
  it("shows the agent, model and effort on the chip and sends that effort", async () => {
    const { chip, onSubmit } = renderPicker()
    expect(chip().textContent).toContain("Opus")
    expect(chip().textContent).toContain("高")
    await userEvent.type(screen.getByRole("textbox"), "go")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("go", { effort: "high" })
  })

  it("lists only the selected agent's models and switches across agents", async () => {
    const { chip, onSelectModel } = renderPicker()
    await userEvent.click(chip())
    const list = await screen.findByRole("listbox", { name: "Claude Code" })
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual([expect.stringContaining("Opus"), expect.stringContaining("Haiku")])
    expect(screen.queryByText("GPT-6.1 Sol")).toBeNull()

    await userEvent.click(screen.getByRole("tab", { name: "Codex" }))
    const codex = await screen.findByRole("listbox", { name: "Codex" })
    expect(within(codex).getByText("GPT-6.1 Sol")).toBeTruthy()
    expect(within(codex).queryByText("Opus")).toBeNull()
    await userEvent.click(within(codex).getByText("GPT-6.1 Sol"))
    expect(onSelectModel).toHaveBeenCalledWith("codex", "gpt-6.1-sol")
  })

  it("loads an agent's catalog only when it is shown", async () => {
    const onLoadModels = vi.fn()
    const { chip } = renderPicker({ catalog: {}, onLoadModels })
    // 当前 agent 的目录用于胶囊上的模型名，挂载时读取一次。
    expect(onLoadModels).toHaveBeenCalledWith("claude")
    expect(onLoadModels).not.toHaveBeenCalledWith("codex")
    await userEvent.click(chip())
    expect(await screen.findByText("正在读取模型…")).toBeTruthy()
    await userEvent.click(screen.getByRole("tab", { name: "Codex" }))
    await waitFor(() => expect(onLoadModels).toHaveBeenCalledWith("codex"))
  })

  it("filters with the search box and picks with ⌘/Ctrl+number", async () => {
    const { chip, onSelectModel } = renderPicker()
    await userEvent.click(chip())
    const search = await screen.findByRole("textbox", { name: "搜索模型…" })
    await waitFor(() => expect(document.activeElement).toBe(search))
    await userEvent.type(search, "hai")
    const list = screen.getByRole("listbox", { name: "Claude Code" })
    expect(within(list).getAllByRole("option")).toHaveLength(1)
    await userEvent.keyboard("{Control>}1{/Control}")
    expect(onSelectModel).toHaveBeenCalledWith("claude", "haiku")
  })

  it("keeps favorites across agents in the star tab", async () => {
    const { chip } = renderPicker()
    await userEvent.click(chip())
    await userEvent.click(screen.getByRole("tab", { name: "Codex" }))
    await userEvent.click(await screen.findByRole("button", { name: "收藏" }))
    await userEvent.click(screen.getByRole("tab", { name: "收藏" }))
    const favorites = await screen.findByRole("listbox", { name: "收藏" })
    expect(within(favorites).getByText("GPT-6.1 Sol")).toBeTruthy()
    expect(within(favorites).getByText(/Codex/)).toBeTruthy()
    expect(JSON.parse(window.localStorage.getItem("pigcode.favoriteModels") ?? "[]")).toEqual([
      "codex/gpt-6.1-sol",
    ])
  })

  it("offers only the efforts the current model supports and remembers the choice", async () => {
    const { chip, onSubmit } = renderPicker()
    await userEvent.click(chip())
    const efforts = await screen.findByRole("radiogroup", { name: "思考深度" })
    expect(
      within(efforts)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["低", "中", "高", "最高"])
    await userEvent.click(within(efforts).getByRole("radio", { name: "最高" }))
    expect(chip().textContent).toContain("最高")
    await userEvent.keyboard("{Escape}")
    await userEvent.type(screen.getByRole("textbox", { name: "给 agent 的消息" }), "deep")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("deep", { effort: "max" })
  })

  it("hides the effort control for a model without efforts", async () => {
    const { chip } = renderPicker({ modelId: "haiku" })
    expect(chip().textContent).toContain("Haiku")
    await userEvent.click(chip())
    await screen.findByRole("listbox", { name: "Claude Code" })
    expect(screen.queryByRole("radiogroup", { name: "思考深度" })).toBeNull()
  })

  it("does not switch models while a run is going", async () => {
    const { chip, onSelectModel } = renderPicker({ running: true })
    await userEvent.click(chip())
    expect(await screen.findByText(/运行中不能切换模型/)).toBeTruthy()
    await userEvent.click(screen.getByText("Haiku"))
    expect(onSelectModel).not.toHaveBeenCalled()
  })
})
