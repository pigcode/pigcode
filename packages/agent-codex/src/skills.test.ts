/** 验证 Codex 的 skill：只要请求的工作目录、停用的不列、说明优先用短说明，插入 `$名字`。 */
import { describe, expect, it } from "vitest"
import { parseCodexSkills } from "./skills"

/** 真实 app-server（codex-cli 0.167.0）的 `skills/list` 返回，删掉了图标等用不到的字段。 */
const RESPONSE = {
  data: [
    {
      cwd: "/work/app",
      skills: [
        {
          name: "documents:documents",
          description: "Create, edit, redline, and comment on `.docx` documents.",
          interface: {
            displayName: "Documents",
            shortDescription: "Create and edit Word and Google Docs files",
          },
          path: "/home/user/.codex/plugins/cache/documents/skills/documents/SKILL.md",
          scope: "user",
          enabled: true,
        },
        {
          name: "release-notes",
          description: "Draft release notes from merged PRs",
          path: "/work/app/.codex/skills/release-notes/SKILL.md",
          scope: "repo",
          enabled: true,
        },
        {
          name: "old-skill",
          description: "Turned off in config",
          path: "/home/user/.codex/skills/old-skill/SKILL.md",
          scope: "user",
          enabled: false,
        },
      ],
      errors: [],
    },
    {
      cwd: "/work/other",
      skills: [{ name: "other-only", description: "x", path: "/x", enabled: true }],
      errors: [],
    },
  ],
}

describe("Codex skills", () => {
  it("lists the enabled skills of the requested workspace as $name", () => {
    expect(parseCodexSkills(RESPONSE, "/work/app")).toEqual([
      {
        name: "documents:documents",
        text: "$documents:documents",
        description: "Create and edit Word and Google Docs files",
        kind: "skill",
      },
      {
        name: "release-notes",
        text: "$release-notes",
        description: "Draft release notes from merged PRs",
        kind: "skill",
      },
    ])
  })

  it("merges every workspace when none matches, and ignores malformed replies", () => {
    expect(parseCodexSkills(RESPONSE, null).map((skill) => skill.name)).toEqual([
      "documents:documents",
      "release-notes",
      "other-only",
    ])
    expect(parseCodexSkills({ data: "nope" }, "/work/app")).toEqual([])
    expect(parseCodexSkills(null, null)).toEqual([])
  })
})
