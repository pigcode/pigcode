/** 验证模型选择器：选中 agent 才列出它的模型、懒加载目录、跨 agent 切换、收藏、思考深度与列表滚动。 */
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { Composer } from "./composer"
import { resetComposerMemory } from "./composer-memory"
import type {
  ComposerAgent,
  ComposerModel,
  ComposerModelCatalog,
  ReasoningEffort,
} from "./composer-options"
import { resetModelPreferencesCache } from "./model-preferences"

const AGENTS: ComposerAgent[] = [
  { id: "claude", label: "Claude Code", installed: true },
  { id: "codex", label: "Codex", installed: false },
]

const CATALOG: ComposerModelCatalog = {
  claude: [
    { id: "opus", label: "Opus", isDefault: true, efforts: ["low", "medium", "high", "max"] },
    { id: "haiku", label: "Haiku", description: "最快", isDefault: false, efforts: [] },
  ],
  codex: [
    { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", isDefault: true, efforts: ["minimal", "xhigh"] },
  ],
}

const CLAUDE_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"]
const claudeModel = (id: string, label: string, efforts = CLAUDE_EFFORTS): ComposerModel => ({
  id,
  label,
  isDefault: id === "default",
  efforts,
})

/** Claude Code 2.1 读到的目录：模型多到要滚动。 */
const CLAUDE_CATALOG: ComposerModelCatalog = {
  claude: [
    claudeModel("default", "Default (recommended)"),
    claudeModel("opus", "Opus 5.5"),
    claudeModel("sonnet", "Sonnet 5.5"),
    claudeModel("fable", "Fable 5.1"),
    claudeModel("haiku", "Haiku 5.5"),
    claudeModel("claude-haiku-4-5-20251001", "Haiku 4.5", []),
    claudeModel("claude-sonnet-5", "Sonnet 5"),
    claudeModel("claude-opus-5", "Opus 5"),
    claudeModel("claude-fable-5", "Fable 5"),
    claudeModel("claude-opus-4-8", "Opus 4.8"),
    claudeModel("claude-opus-4-7", "Opus 4.7"),
    claudeModel("claude-opus-4-6", "Opus 4.6", ["low", "medium", "high", "max"]),
    claudeModel("claude-sonnet-4-6", "Sonnet 4.6"),
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

/** 先存好某个模型的思考深度，就像用户上次选过。 */
function storeEffort(key: string, effort: ReasoningEffort): void {
  window.localStorage.setItem("pigcode.modelEfforts", JSON.stringify({ [key]: effort }))
  resetModelPreferencesCache()
}

describe("ModelPicker", () => {
  it("shows the agent, model and stored effort on the chip and sends that effort", async () => {
    storeEffort("claude/opus", "high")
    const { chip, onSubmit } = renderPicker()
    expect(chip().textContent).toContain("Opus")
    expect(chip().textContent).toContain("高")
    await userEvent.type(screen.getByRole("textbox"), "go")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("go", { effort: "high" })
  })

  it("starts at 默认 when nothing is stored: bare model name on the chip and no effort sent", async () => {
    const { chip, onSubmit } = renderPicker()
    expect(chip().getAttribute("aria-label")).toBe("Agent 与模型: Claude Code · Opus")
    await userEvent.type(screen.getByRole("textbox"), "go")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("go", { effort: null })

    await userEvent.click(chip())
    const efforts = await screen.findByRole("radiogroup", { name: "思考深度" })
    expect(within(efforts).getByRole("radio", { name: "默认" }).getAttribute("aria-checked")).toBe(
      "true",
    )
    expect(within(efforts).getAllByRole("radio", { checked: true })).toHaveLength(1)
  })

  it("clears the stored effort when 默认 is chosen", async () => {
    storeEffort("claude/opus", "max")
    const { chip, onSubmit } = renderPicker()
    await userEvent.click(chip())
    const efforts = await screen.findByRole("radiogroup", { name: "思考深度" })
    expect(within(efforts).getByRole("radio", { name: "最高" }).getAttribute("aria-checked")).toBe(
      "true",
    )
    await userEvent.click(within(efforts).getByRole("radio", { name: "默认" }))
    expect(JSON.parse(window.localStorage.getItem("pigcode.modelEfforts") ?? "{}")).toEqual({})
    expect(chip().getAttribute("aria-label")).toBe("Agent 与模型: Claude Code · Opus")
    expect(chip().textContent).not.toContain("最高")
    await userEvent.keyboard("{Escape}")
    await userEvent.type(screen.getByRole("textbox", { name: "给 agent 的消息" }), "plain")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenLastCalledWith("plain", { effort: null })
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
    const search = await screen.findByRole("searchbox", { name: "搜索模型…" })
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
    ).toEqual(["默认", "低", "中", "高", "最高"])
    await userEvent.click(within(efforts).getByRole("radio", { name: "最高" }))
    expect(chip().textContent).toContain("最高")
    await userEvent.keyboard("{Escape}")
    await userEvent.type(screen.getByRole("textbox", { name: "给 agent 的消息" }), "deep")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("deep", { effort: "max" })
  })

  it("moves the effort with arrow keys without switching agents, and Enter still picks the model", async () => {
    const { chip, onSelectModel } = renderPicker()
    await userEvent.click(chip())
    const efforts = await screen.findByRole("radiogroup", { name: "思考深度" })
    await userEvent.click(within(efforts).getByRole("radio", { name: "高" }))
    await userEvent.keyboard("{ArrowRight}")
    expect(within(efforts).getByRole("radio", { name: "最高" }).getAttribute("aria-checked")).toBe(
      "true",
    )
    expect(screen.getByRole("listbox", { name: "Claude Code" })).toBeTruthy()
    // 「默认」是同一组里的第一段，方向键一样能走到它。
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}{ArrowLeft}{ArrowLeft}")
    expect(within(efforts).getByRole("radio", { name: "默认" }).getAttribute("aria-checked")).toBe(
      "true",
    )
    expect(chip().getAttribute("aria-label")).toBe("Agent 与模型: Claude Code · Opus")

    await userEvent.keyboard("{Enter}")
    expect(onSelectModel).toHaveBeenCalledWith("claude", "opus")
  })

  it("offers Claude Code's thinking levels outside the scrolling list and sends the one picked", async () => {
    const { chip, onSubmit } = renderPicker({ catalog: CLAUDE_CATALOG, modelId: "default" })
    // 没选过档位时交给 Claude Code 自己决定：胶囊上不显示，发送时也不带。
    expect(chip().getAttribute("aria-label")).toBe(
      "Agent 与模型: Claude Code · Default (recommended)",
    )
    const input = screen.getByRole("textbox", { name: "给 agent 的消息" })
    await userEvent.type(input, "a")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenLastCalledWith("a", { effort: null })

    await userEvent.click(chip())
    const list = await screen.findByRole("listbox", { name: "Claude Code" })
    expect(within(list).getAllByRole("option")).toHaveLength(13)
    const efforts = screen.getByRole("radiogroup", { name: "思考深度" })
    // 列表再长，搜索框和思考深度也不在滚动的列表里。
    expect(list.contains(screen.getByRole("searchbox", { name: "搜索模型…" }))).toBe(false)
    expect(list.contains(efforts)).toBe(false)
    expect(
      within(efforts)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["默认", "低", "中", "高", "超高", "最高"])
    expect(within(efforts).getByRole("radio", { name: "默认" }).getAttribute("aria-checked")).toBe(
      "true",
    )
    await userEvent.click(within(efforts).getByRole("radio", { name: "超高" }))
    expect(chip().textContent).toContain("超高")
    await userEvent.keyboard("{Escape}")
    await userEvent.type(input, "go")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenLastCalledWith("go", { effort: "xhigh" })
  })

  it("scrolls only the list to follow the keyboard, not the pointer", async () => {
    const { chip } = renderPicker({ catalog: CLAUDE_CATALOG, modelId: "default" })
    await userEvent.click(chip())
    const search = await screen.findByRole("searchbox", { name: "搜索模型…" })
    await waitFor(() => expect(document.activeElement).toBe(search))
    const list = screen.getByRole("listbox", { name: "Claude Code" })
    const options = within(list).getAllByRole("option")
    // jsdom 没有布局：列表高 100，每行高 40，各行的位置随 scrollTop 移动。
    let scrollTop = 0
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = value
      },
    })
    const box = (top: number, height: number) =>
      ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top }) as DOMRect
    vi.spyOn(list, "getBoundingClientRect").mockImplementation(() => box(0, 100))
    options.forEach((option, row) => {
      vi.spyOn(option, "getBoundingClientRect").mockImplementation(() =>
        box(row * 40 - scrollTop, 40),
      )
    })

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}")
    expect(scrollTop).toBe(60)
    await userEvent.hover(options[0] as HTMLElement)
    expect(options[0]?.hasAttribute("data-highlighted")).toBe(true)
    expect(scrollTop).toBe(60)
    await userEvent.keyboard("{ArrowDown}")
    expect(scrollTop).toBe(40)
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
