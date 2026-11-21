import { TEST_MODES } from "./permission-fixture"
/** 验证输入框的 @ 文件引用与 / 命令：列表筛选、键盘选择，以及发送时写成 @路径。 */
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ComponentProps } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { Composer } from "./composer"
import { resetComposerMemory } from "./composer-memory"
import { matchFiles } from "./fuzzy"

afterEach(() => {
  cleanup()
  resetComposerMemory()
})

const FILES = ["README.md", "src/index.ts", "src/components/button.tsx", "docs/guide.md"]

function renderComposer(props: Partial<ComponentProps<typeof Composer>> = {}) {
  render(
    <LocaleProvider locale="zh-CN">
      <Composer executionModes={TEST_MODES} onSubmit={() => {}} onStop={() => {}} {...props} />
    </LocaleProvider>,
  )
  return screen.getByRole("textbox")
}

describe("file matching", () => {
  it("ranks file-name hits above directory hits", () => {
    expect(matchFiles(FILES, "idx")).toEqual(["src/index.ts"])
    expect(matchFiles(FILES, "btn")[0]).toBe("src/components/button.tsx")
    expect(matchFiles(FILES, "")).toEqual(FILES)
    expect(matchFiles(FILES, "zzz")).toEqual([])
  })
})

describe("composer suggestions", () => {
  it("references a project file with @ and sends it as @path", async () => {
    const onSubmit = vi.fn()
    const files = vi.fn(async () => FILES)
    const editor = renderComposer({ onSubmit, files })
    await userEvent.type(editor, "look at @ind")
    const list = await screen.findByRole("listbox", { name: "文件" })
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(1))
    expect(within(list).getByRole("option").textContent).toContain("index.ts")
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "文件" })).toBeNull())
    expect(editor.querySelector(".mention-chip")?.textContent).toBe("@src/index.ts")

    await userEvent.keyboard("please")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("look at @src/index.ts please", { effort: null })
    expect(files).toHaveBeenCalledTimes(1)
  })

  it("moves through file suggestions with the arrow keys", async () => {
    const editor = renderComposer({ files: async () => FILES })
    await userEvent.type(editor, "@")
    const list = await screen.findByRole("listbox", { name: "文件" })
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(FILES.length))
    expect(within(list).getAllByRole("option")[0]?.getAttribute("aria-selected")).toBe("true")
    await userEvent.keyboard("{ArrowDown}")
    expect(within(list).getAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true")
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "文件" })).toBeNull())
  })

  it("runs a slash command at the start of the input and removes the command text", async () => {
    const run = vi.fn()
    const onSubmit = vi.fn()
    const editor = renderComposer({
      onSubmit,
      commands: [
        { id: "new", label: "/new", description: "新会话", run },
        { id: "panel", label: "/panel", description: "工作台", run: () => {} },
      ],
    })
    await userEvent.type(editor, "/ne")
    const list = await screen.findByRole("listbox", { name: "命令" })
    expect(within(list).getAllByRole("option")[0]?.textContent).toContain("/new")
    await userEvent.keyboard("{Enter}")
    expect(run).toHaveBeenCalledTimes(1)
    expect(editor.textContent).toBe("")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("toggles planning independently with a built-in command", async () => {
    const onPlanMode = vi.fn()
    const editor = renderComposer({ onPlanMode })
    await userEvent.type(editor, "/plan")
    await screen.findByRole("listbox", { name: "命令" })
    await userEvent.keyboard("{Enter}")
    expect(onPlanMode).toHaveBeenCalledWith(true)
  })

  it("executes a Pigcode command while the Agent directory is still loading", async () => {
    const onPlanMode = vi.fn()
    const onSubmit = vi.fn()
    const editor = renderComposer({
      agentId: "claude",
      onPlanMode,
      onSubmit,
      loadAgentCommands: () => new Promise(() => {}),
    })

    await userEvent.type(editor, "/plan{Enter}")

    expect(onPlanMode).toHaveBeenCalledWith(true)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("sends the text as typed when @ has no matching file", async () => {
    const onSubmit = vi.fn()
    const editor = renderComposer({ onSubmit, files: async () => FILES })
    await userEvent.type(editor, "email me@nowhere")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("email me@nowhere", { effort: null })
  })

  it("lists the agent's skills and commands after Pigcode's own and inserts the chosen one", async () => {
    const onSubmit = vi.fn()
    const run = vi.fn()
    const loadAgentCommands = vi.fn(async () => AGENT_COMMANDS)
    const editor = renderComposer({
      onSubmit,
      agentId: "claude",
      loadAgentCommands,
      commands: [{ id: "new", label: "/new", description: "新会话", run }],
    })
    // 获得焦点就预取，敲 / 时已经读好。
    await userEvent.click(editor)
    await waitFor(() => expect(loadAgentCommands).toHaveBeenCalledWith("claude"))
    await userEvent.type(editor, "/")
    const list = await screen.findByRole("listbox", { name: "命令" })
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(4))
    const options = within(list).getAllByRole("option")
    // Pigcode 自己的命令在前，然后是 skill，Agent 内置命令最后；和 Pigcode 重名的 /new 不重复列。
    expect(options.map((option) => option.dataset.source)).toEqual([
      "pigcode",
      "skill",
      "builtin",
      "builtin",
    ])
    expect(options[1]?.textContent).toContain("/frontend-design")
    expect(options[1]?.textContent).toContain("<brief>")
    expect(options[1]?.textContent).toContain("Skill")

    await userEvent.type(editor, "front")
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(1))
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "命令" })).toBeNull())
    expect(run).not.toHaveBeenCalled()
    await userEvent.keyboard("a landing page")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("/frontend-design a landing page", { effort: null })
  })

  it("opens the skill picker with $ in a sentence and searches Matt skills", async () => {
    const onSubmit = vi.fn()
    const editor = renderComposer({
      onSubmit,
      agentId: "codex",
      loadAgentCommands: async () => [
        {
          name: "mattpocock-skills:ask-matt",
          text: "$mattpocock-skills:ask-matt",
          kind: "skill",
          description: "Choose the right workflow",
        },
      ],
    })
    await userEvent.type(editor, "帮我 $matt")
    const list = await screen.findByRole("listbox")
    await expect(within(list).findByRole("option", { name: /ask-matt/i })).resolves.toBeTruthy()
    await userEvent.keyboard("{Enter}")
    expect(editor.textContent).toContain("$mattpocock-skills:ask-matt")
    await userEvent.keyboard("{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("帮我 $mattpocock-skills:ask-matt", { effort: null })
  })

  it("uses the display name for skills and preserves the qualified invocation when sending", async () => {
    const onSubmit = vi.fn()
    const loadAgentCommands = vi.fn(async () => [
      {
        name: "mattpocock-skills:ask-matt",
        text: "$mattpocock-skills:ask-matt",
        kind: "skill" as const,
        displayName: "Ask Matt",
        description: "Choose an engineering workflow",
        scope: "user",
        pluginId: "matt@market",
      },
      { name: "compact", text: "/compact", kind: "builtin" as const },
    ])
    const editor = renderComposer({ onSubmit, agentId: "codex", loadAgentCommands })
    await userEvent.type(editor, "$engineering")
    const list = await screen.findByRole("listbox", { name: "Skill" })
    const option = await within(list).findByRole("option", { name: /Ask Matt/ })
    expect(option.textContent).toContain("插件")
    expect(loadAgentCommands.mock.calls.filter((args: unknown[]) => args[1] === true)).toHaveLength(
      1,
    )
    await userEvent.keyboard("{Tab}")
    await userEvent.keyboard("help{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("$mattpocock-skills:ask-matt help", { effort: null })
  })

  it("reloads skills after closing the menu and keeps slash commands separate", async () => {
    let names = ["old"]
    const loadAgentCommands = vi.fn(async () =>
      names.map((name) => ({ name, text: `$${name}`, kind: "skill" as const })),
    )
    const editor = renderComposer({ agentId: "codex", loadAgentCommands })
    await userEvent.type(editor, "$")
    await screen.findByRole("option", { name: /old/ })
    await userEvent.keyboard("{Escape}")
    names = ["ask-matt"]
    await userEvent.clear(editor)
    await userEvent.type(editor, "$matt")
    await screen.findByRole("option", { name: /ask-matt/ })
    await userEvent.keyboard("{Escape}")
    await userEvent.clear(editor)
    await userEvent.type(editor, "/matt")
    await screen.findByText("没找到命令")
  })

  it("keeps Claude plugin skills callable through their native slash commands", async () => {
    const onSubmit = vi.fn()
    const editor = renderComposer({
      onSubmit,
      agentId: "claude",
      loadAgentCommands: async () => [
        {
          name: "mattpocock-skills:ask-matt",
          text: "/mattpocock-skills:ask-matt",
          kind: "skill",
          description: "Pick a workflow",
        },
      ],
    })
    await userEvent.type(editor, "/matt")
    await screen.findByRole("option", { name: /ask-matt/ })
    await userEvent.keyboard("{Enter}help{Enter}")
    expect(onSubmit).toHaveBeenCalledWith("/mattpocock-skills:ask-matt help", { effort: null })
  })

  it("lists only Pigcode's commands when the agent has none", async () => {
    const editor = renderComposer({
      agentId: "codex",
      loadAgentCommands: async () => {
        throw new Error("app-server failed")
      },
      commands: [{ id: "new", label: "/new", description: "新会话", run: () => {} }],
    })
    await userEvent.type(editor, "/")
    const list = await screen.findByRole("listbox", { name: "命令" })
    await waitFor(() => expect(within(list).getAllByRole("option")).toHaveLength(1))
  })
})

const AGENT_COMMANDS = [
  { name: "compact", text: "/compact", description: "Summarize the conversation", kind: "builtin" },
  {
    name: "frontend-design",
    text: "/frontend-design",
    description: "Distinctive visual design",
    argumentHint: "<brief>",
    kind: "skill",
  },
  { name: "new", text: "/new", kind: "builtin" },
  { name: "context", text: "/context", kind: "builtin" },
] as const
