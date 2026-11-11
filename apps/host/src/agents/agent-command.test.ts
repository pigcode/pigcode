import { describe, expect, it } from "vitest"
import { startsWithAgentCommand } from "./agent-command"

describe("startsWithAgentCommand", () => {
  it.each([
    ["/compact", true],
    ["/compact keep the decisions", true],
    ["  /review the diff", true],
    ["/documents:pdf make a report", true],
    ["$skill-creator new skill", true],
    ["/usr/lib/foo 在哪", false],
    ["/", false],
    ["please run /compact", false],
    ["hello", false],
    ["", false],
  ])("%j → %s", (text, expected) => {
    expect(startsWithAgentCommand(text)).toBe(expected)
  })
})
