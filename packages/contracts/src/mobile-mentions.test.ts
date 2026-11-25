import { describe, expect, it } from "vitest"
import {
  mobileAgentCommand,
  mobileAgentCommandKind,
  mobileAgentCommandsParams,
  mobileAgentCommandsResult,
  mobileAgentCommandSource,
  mobileFeatures,
  mobileMentionMethods,
  mobileMentionsJsonSchemas,
  mobilePathEntry,
  mobilePathEntryKind,
  mobileSearchPathsMaxLimit,
  mobileSearchPathsParams,
  mobileSearchPathsQueryLimit,
  mobileSearchPathsResult,
} from "./index"

describe("mobile mentions contracts", () => {
  it("declares composer.mentions in mobileFeatures and exposes mention method names", () => {
    expect(mobileFeatures).toContain("composer.mentions")
    expect(mobileMentionMethods).toEqual({
      searchPaths: "workspace.searchPaths",
      agentCommands: "agent.commands",
    })
  })

  it("validates workspace.searchPaths params and results strictly", () => {
    expect(mobileSearchPathsParams.parse({ projectId: "pr_1" })).toEqual({
      projectId: "pr_1",
      query: "",
    })
    expect(
      mobileSearchPathsParams.parse({
        threadId: "th_1",
        query: "src/app",
        limit: mobileSearchPathsMaxLimit,
        refresh: true,
      }),
    ).toEqual({
      threadId: "th_1",
      query: "src/app",
      limit: mobileSearchPathsMaxLimit,
      refresh: true,
    })

    // Scope must specify exactly one of threadId or projectId.
    expect(mobileSearchPathsParams.safeParse({ query: "a" }).success).toBe(false)
    expect(
      mobileSearchPathsParams.safeParse({ threadId: "th_1", projectId: "pr_1", query: "a" })
        .success,
    ).toBe(false)
    expect(mobileSearchPathsParams.safeParse({ projectId: "" }).success).toBe(false)
    expect(mobileSearchPathsParams.safeParse({ threadId: "" }).success).toBe(false)

    // Bounds & strictness.
    expect(mobileSearchPathsParams.safeParse({ projectId: "pr_1", limit: 0 }).success).toBe(false)
    expect(
      mobileSearchPathsParams.safeParse({ projectId: "pr_1", limit: mobileSearchPathsMaxLimit + 1 })
        .success,
    ).toBe(false)
    expect(mobileSearchPathsParams.safeParse({ projectId: "pr_1", limit: 1.5 }).success).toBe(false)
    expect(
      mobileSearchPathsParams.safeParse({
        projectId: "pr_1",
        query: "a".repeat(mobileSearchPathsQueryLimit + 1),
      }).success,
    ).toBe(false)
    expect(mobileSearchPathsParams.safeParse({ projectId: "pr_1", extra: true }).success).toBe(
      false,
    )

    expect(mobilePathEntryKind.options).toEqual(["file", "dir"])
    expect(mobilePathEntry.parse({ path: "src/index.ts", kind: "file" })).toEqual({
      path: "src/index.ts",
      kind: "file",
    })
    expect(mobilePathEntry.safeParse({ path: "src", kind: "directory" }).success).toBe(false)
    expect(mobilePathEntry.safeParse({ path: "", kind: "file" }).success).toBe(false)
    expect(
      mobilePathEntry.safeParse({ path: "src/index.ts", kind: "file", extra: 1 }).success,
    ).toBe(false)

    const result = {
      entries: [
        { path: "src/index.ts", kind: "file" as const },
        { path: "src", kind: "dir" as const },
      ],
      truncated: true,
    }
    expect(mobileSearchPathsResult.parse(result)).toEqual(result)
    expect(mobileSearchPathsResult.safeParse({ entries: [] }).success).toBe(false)
    expect(
      mobileSearchPathsResult.safeParse({ ...result, extra: true }).success,
    ).toBe(false)
  })

  it("validates agent.commands params and results and enforces / vs $ prefix distinction", () => {
    expect(mobileAgentCommandsParams.parse({ instanceId: "claude" })).toEqual({
      instanceId: "claude",
    })
    expect(
      mobileAgentCommandsParams.parse({
        instanceId: "claude",
        threadId: "th_1",
        refresh: true,
      }),
    ).toEqual({
      instanceId: "claude",
      threadId: "th_1",
      refresh: true,
    })
    expect(
      mobileAgentCommandsParams.parse({
        instanceId: "claude",
        projectId: "pr_1",
      }),
    ).toEqual({
      instanceId: "claude",
      projectId: "pr_1",
    })

    // Conflicting scope or invalid fields rejected.
    expect(
      mobileAgentCommandsParams.safeParse({
        instanceId: "claude",
        threadId: "th_1",
        projectId: "pr_1",
      }).success,
    ).toBe(false)
    expect(mobileAgentCommandsParams.safeParse({ instanceId: "" }).success).toBe(false)
    expect(mobileAgentCommandsParams.safeParse({ instanceId: "claude", extra: 1 }).success).toBe(
      false,
    )

    expect(mobileAgentCommandKind.options).toEqual(["command", "skill"])
    expect(mobileAgentCommandSource.options).toEqual([
      "builtin",
      "custom",
      "user",
      "project",
      "plugin",
      "system",
    ])

    const slashCmd = {
      name: "review",
      text: "/review",
      kind: "command" as const,
      description: "Review pending changes",
      argumentHint: "<branch>",
      source: "builtin" as const,
    }
    const skillCmd = {
      name: "mattpocock-skills:tdd",
      text: "$mattpocock-skills:tdd",
      kind: "skill" as const,
      displayName: "TDD",
      description: "Red-green-refactor workflow",
      shortDescription: "Test-driven development",
      source: "plugin" as const,
    }
    expect(mobileAgentCommand.parse(slashCmd)).toEqual(slashCmd)
    expect(mobileAgentCommand.parse(skillCmd)).toEqual(skillCmd)

    // Prefix must match kind.
    expect(
      mobileAgentCommand.safeParse({ name: "review", text: "$review", kind: "command" }).success,
    ).toBe(false)
    expect(
      mobileAgentCommand.safeParse({ name: "tdd", text: "/tdd", kind: "skill" }).success,
    ).toBe(false)
    // Host-only fields like filesystem path or pluginId must be rejected.
    expect(
      mobileAgentCommand.safeParse({ ...skillCmd, path: "/Users/me/.claude/skills/tdd/SKILL.md" })
        .success,
    ).toBe(false)
    expect(
      mobileAgentCommand.safeParse({ ...skillCmd, pluginId: "mattpocock-skills@fixture" }).success,
    ).toBe(false)

    const result = { commands: [slashCmd, skillCmd], truncated: false }
    expect(mobileAgentCommandsResult.parse(result)).toEqual(result)
    expect(mobileAgentCommandsResult.safeParse({ commands: [] }).success).toBe(false)
  })

  it("exports JSON schemas without error", () => {
    const schemas = mobileMentionsJsonSchemas()
    expect(schemas).toHaveProperty("MobilePathEntryKind")
    expect(schemas).toHaveProperty("MobilePathEntry")
    expect(schemas).toHaveProperty("MobileSearchPathsParams")
    expect(schemas).toHaveProperty("MobileSearchPathsResult")
    expect(schemas).toHaveProperty("MobileAgentCommandKind")
    expect(schemas).toHaveProperty("MobileAgentCommandSource")
    expect(schemas).toHaveProperty("MobileAgentCommand")
    expect(schemas).toHaveProperty("MobileAgentCommandsParams")
    expect(schemas).toHaveProperty("MobileAgentCommandsResult")
  })
})
