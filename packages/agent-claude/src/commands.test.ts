/** 验证 Claude 的 `/` 命令：内置命令与 skill 分开、内部命令不列，读命令的会话带上工作目录。 */
import type { Options, Query, SlashCommand } from "@anthropic-ai/claude-agent-sdk"
import { describe, expect, it, vi } from "vitest"
import { listClaudeCommands, parseClaudeCommands } from "./commands"

/** 真实 CLI（2.1.321）返回的几条，原样保留形状。 */
const COMMANDS: SlashCommand[] = [
  {
    name: "compact",
    description: "Free up context by summarizing the conversation so far",
    argumentHint: "<optional custom summarization instructions>",
    builtin: true,
  },
  {
    name: "codex:review",
    description: "(codex) Run a Codex code review against local git state",
    argumentHint: "[--wait|--background] [--base <ref>]",
  },
  { name: "frontend-design", description: "Distinctive visual design", argumentHint: "" },
  {
    name: "__remote-workflow",
    description: "Run the workflow script delivered in this session environment",
    argumentHint: "",
    builtin: true,
  },
]

describe("Claude slash commands", () => {
  it("keeps built-ins apart from skills and drops the CLI's internal commands", () => {
    expect(parseClaudeCommands(COMMANDS)).toEqual([
      {
        name: "compact",
        text: "/compact",
        description: "Free up context by summarizing the conversation so far",
        argumentHint: "<optional custom summarization instructions>",
        kind: "builtin",
      },
      {
        name: "codex:review",
        text: "/codex:review",
        description: "(codex) Run a Codex code review against local git state",
        argumentHint: "[--wait|--background] [--base <ref>]",
        kind: "skill",
      },
      {
        name: "frontend-design",
        text: "/frontend-design",
        description: "Distinctive visual design",
        argumentHint: undefined,
        kind: "skill",
      },
    ])
  })

  it("reads the commands in the workspace and closes the session", async () => {
    const close = vi.fn()
    const queryFn = vi.fn(
      () => ({ supportedCommands: async () => COMMANDS, close }) as unknown as Query,
    )
    const commands = await listClaudeCommands({
      queryFn,
      executable: "/usr/local/bin/claude",
      detect: async () => ({ installed: true, loggedIn: true }),
      cwd: "/work/app",
    })
    expect(commands.map((command) => command.text)).toEqual([
      "/compact",
      "/codex:review",
      "/frontend-design",
    ])
    const params = queryFn.mock.calls[0] as unknown as [{ options: Options }]
    // 项目级 skill 在 <cwd>/.claude/skills，必须在工作目录里启动。
    expect(params[0].options.cwd).toBe("/work/app")
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("lists nothing when the CLI is missing or signed out", async () => {
    const queryFn = vi.fn()
    const commands = await listClaudeCommands({
      queryFn,
      executable: undefined,
      detect: async () => ({ installed: true, loggedIn: false }),
      cwd: null,
    })
    expect(commands).toEqual([])
    expect(queryFn).not.toHaveBeenCalled()
  })
})
