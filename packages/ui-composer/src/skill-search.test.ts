import { describe, expect, it } from "vitest"
import { toComposerCommands } from "./agent-commands"
import { searchCommands, searchSkills, skillScope } from "./skill-search"

const commands = toComposerCommands([
  {
    name: "mattpocock-skills:ask-matt",
    text: "$mattpocock-skills:ask-matt",
    kind: "skill",
    displayName: "Ask Matt",
    shortDescription: "Pick a workflow",
    description: "Choose a Matt Pocock engineering skill",
    scope: "user",
    pluginId: "mattpocock-skills@market",
  },
  {
    name: "debug",
    text: "$debug",
    kind: "skill",
    displayName: "Diagnose",
    description: "Trace exceptions",
    scope: "project",
  },
  { name: "compact", text: "/compact", kind: "builtin" },
])

describe("skill search", () => {
  it("does not fuzzy-match long descriptions into unrelated slash command results", () => {
    const native = toComposerCommands([
      {
        name: "mattpocock-skills:ask-matt",
        text: "/mattpocock-skills:ask-matt",
        kind: "skill",
        description: "Pick a workflow",
      },
      { name: "tool", text: "/tool", kind: "skill", description: "Make a tool that works" },
      { name: "guide", text: "/guide", kind: "skill", description: "Follow Matt's workflow" },
    ])
    expect(searchCommands(native, "matt").map((command) => command.insert)).toEqual([
      "/mattpocock-skills:ask-matt",
      "/guide",
    ])
    expect(searchCommands(native, "workflow")).toHaveLength(2)
  })
  it("searches native names, display names, both descriptions and scope", () => {
    for (const query of ["matt", "$matt", "ask matt", "workflow", "engineering", "user", "mpask"]) {
      expect(
        searchSkills(commands, query).map((c) => c.insert),
        query,
      ).toEqual(["$mattpocock-skills:ask-matt"])
    }
    expect(searchSkills(commands, "exceptions")[0]?.insert).toBe("$debug")
    expect(searchSkills(commands, "project")[0]?.insert).toBe("$debug")
    expect(searchSkills(commands, "no-match")).toEqual([])
    expect(skillScope(commands[0]!)).toBe("plugin")
    expect(skillScope(commands[1]!)).toBe("project")
  })

  it("keeps all skills and ranks name hits above description matches", () => {
    const many = toComposerCommands(
      Array.from({ length: 180 }, (_, i) => ({
        name: `skill-${i}`,
        text: `$skill-${i}`,
        kind: "skill" as const,
        description: "debug",
      })),
    )
    expect(searchSkills([...many, ...commands], "")).toHaveLength(182)
    expect(searchSkills([...many, ...commands], "debug")[0]?.insert).toBe("$debug")
  })
})
