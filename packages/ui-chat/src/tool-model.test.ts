/** 验证工具的展示族、写文件的改动解析、工具字段读取与连续工具的合并规则。 */
import { describe, expect, it } from "vitest"
import { fileChanges, mergeFileChanges, unifiedDiffLines } from "./file-changes"
import {
  askedQuestions,
  fetchUrl,
  humanizeName,
  mcpCall,
  readPath,
  searchSummary,
  skillFields,
  taskOutput,
  todoItems,
} from "./tool-fields"
import {
  browserAction,
  isHiddenTool,
  isReadOnlyCommand,
  mcpParts,
  toolFamily,
} from "./tool-identity"
import type { ToolCall } from "./tool-meta"
import { groupTools } from "./work-groups"

function tool(name: string, inputValue: unknown, extra: Partial<ToolCall> = {}): ToolCall {
  return {
    id: extra.id ?? name,
    name,
    status: "completed",
    input: typeof inputValue === "string" ? inputValue : JSON.stringify(inputValue),
    output: undefined,
    inputValue,
    ...extra,
  }
}

describe("tool identity", () => {
  it("maps Claude, Codex and MCP tool names to display families", () => {
    expect(toolFamily("Read")).toBe("file-read")
    expect(toolFamily("MultiEdit")).toBe("file-write")
    expect(toolFamily("apply_patch")).toBe("file-write")
    expect(toolFamily("Bash")).toBe("shell")
    expect(toolFamily("exec_command")).toBe("shell")
    expect(toolFamily("WebSearch")).toBe("search")
    expect(toolFamily("WebFetch")).toBe("web-fetch")
    expect(toolFamily("TodoWrite")).toBe("todo")
    expect(toolFamily("BashOutput")).toBe("task-output")
    expect(toolFamily("KillShell")).toBe("task-stop")
    expect(toolFamily("ExitPlanMode")).toBe("switch-mode")
    expect(toolFamily("mcp__context7__get-library-docs")).toBe("mcp")
    expect(toolFamily("mcp__pigcode__browser_click")).toBe("browser")
    expect(toolFamily("Frobnicate")).toBe("unknown")
    expect(mcpParts("mcp__github__create_issue")).toEqual({
      server: "github",
      tool: "create_issue",
    })
    expect(browserAction("mcp__pigcode__browser_wait_for")).toBe("wait_for")
    expect(browserAction("mcp__github__create_issue")).toBeNull()
  })

  it("hides todos and entering plan mode from the stream", () => {
    expect(isHiddenTool("TodoWrite")).toBe(true)
    expect(isHiddenTool("update_plan")).toBe(true)
    expect(isHiddenTool("EnterPlanMode")).toBe(true)
    expect(isHiddenTool("ExitPlanMode")).toBe(false)
  })

  it("treats lookups as read-only and anything that writes as a real command", () => {
    expect(isReadOnlyCommand("rg -n answer src")).toBe(true)
    expect(isReadOnlyCommand("cd src && ls -la | head -5")).toBe(true)
    expect(isReadOnlyCommand("git status")).toBe(true)
    expect(isReadOnlyCommand("cat a.txt > b.txt")).toBe(false)
    expect(isReadOnlyCommand("pnpm test")).toBe(false)
    expect(isReadOnlyCommand("rm -rf dist")).toBe(false)
  })
})

describe("file changes", () => {
  it("diffs Claude edits with context and counts the lines", () => {
    const [change] = fileChanges(
      tool("Edit", { file_path: "/repo/a.ts", old_string: "one\ntwo", new_string: "one\n2\n3" }),
    )
    expect(change).toMatchObject({ path: "/repo/a.ts", operation: "edit", added: 2, removed: 1 })
    expect(change?.lines.map((line) => `${line.kind}:${line.text}`)).toEqual([
      "context:one",
      "remove:two",
      "add:2",
      "add:3",
    ])
  })

  it("reads writes, multi-edits, Codex change lists and *** Begin Patch", () => {
    expect(fileChanges(tool("Write", { file_path: "b.ts", content: "x\ny\n" }))[0]).toMatchObject({
      operation: "write",
      added: 2,
      removed: 0,
    })
    const multi = fileChanges(
      tool("MultiEdit", {
        file_path: "c.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d" },
        ],
      }),
    )[0]
    expect(multi?.lines.filter((line) => line.kind === "gap")).toHaveLength(1)
    const codex = fileChanges(
      tool("ApplyPatch", {
        changes: [
          { path: "d.ts", kind: { type: "update" }, diff: "@@ -1,2 +1,2 @@\n keep\n-old\n+new" },
          { path: "e.ts", kind: { type: "delete" } },
        ],
      }),
    )
    expect(
      codex.map((change) => [change.path, change.operation, change.added, change.removed]),
    ).toEqual([
      ["d.ts", "edit", 1, 1],
      ["e.ts", "delete", 0, 0],
    ])
    expect(codex[0]?.lines[0]).toEqual({ kind: "context", text: "keep", line: 1 })
    const patch = fileChanges(
      tool(
        "apply_patch",
        "*** Begin Patch\n*** Add File: f.md\n+# Title\n+body\n*** Update File: g.ts\n@@\n-a\n+b\n*** End Patch",
      ),
    )
    expect(patch.map((change) => [change.path, change.operation, change.added])).toEqual([
      ["f.md", "write", 2],
      ["g.ts", "edit", 1],
    ])
    expect(fileChanges(tool("Read", { file_path: "a.ts" }))).toEqual([])
  })

  it("merges the changes of one turn by path", () => {
    const merged = mergeFileChanges([
      {
        path: "a.ts",
        operation: "edit",
        added: 1,
        removed: 0,
        lines: [{ kind: "add", text: "x" }],
      },
      { path: "b.ts", operation: "write", added: 3, removed: 0, lines: [] },
      {
        path: "a.ts",
        operation: "edit",
        added: 2,
        removed: 1,
        lines: [{ kind: "add", text: "y" }],
      },
    ])
    expect(merged.map((change) => [change.path, change.added, change.removed])).toEqual([
      ["a.ts", 3, 1],
      ["b.ts", 3, 0],
    ])
    expect(merged[0]?.lines.map((line) => line.kind)).toEqual(["add", "gap", "add"])
    expect(unifiedDiffLines("--- a\n+++ b\n@@ -4 +4 @@\n-x\n+y")).toEqual([
      { kind: "remove", text: "x" },
      { kind: "add", text: "y", line: 4 },
    ])
  })
})

describe("tool fields", () => {
  it("reads paths, searches and urls", () => {
    expect(readPath(tool("Read", { file_path: "/repo/README.md" }))).toBe("/repo/README.md")
    expect(searchSummary(tool("Grep", { pattern: "answer" }))).toEqual({
      kind: "find",
      text: "answer",
    })
    expect(searchSummary(tool("LS", { path: "src" }))).toEqual({ kind: "list", text: "src" })
    expect(searchSummary(tool("ToolSearch", { query: "select:a,b" }))).toEqual({
      kind: "tools",
      text: "a, b",
    })
    expect(fetchUrl(tool("WebFetch", { url: "https://x.dev", prompt: "summarise" }))).toBe(
      "https://x.dev",
    )
  })

  it("reads todos, questions with answers, skills and task output", () => {
    expect(
      todoItems({
        todos: [
          { content: "Read", status: "completed" },
          { content: "Fix", status: "in_progress" },
          "Ship",
        ],
      }),
    ).toEqual([
      { text: "Read", status: "completed" },
      { text: "Fix", status: "in-progress" },
      { text: "Ship", status: "pending" },
    ])
    const asked = tool(
      "AskUserQuestion",
      { questions: [{ question: "Which OS?", header: "OS" }, { question: "Runner?" }] },
      { output: 'User has answered your questions: "Which OS?"="macOS". You can now continue.' },
    )
    expect(askedQuestions(asked)).toEqual([
      { question: "Which OS?", header: "OS", answer: "macOS" },
      { question: "Runner?", header: undefined, answer: undefined },
    ])
    expect(skillFields(tool("Skill", { skill: "pdf", args: "report.pdf" }))).toEqual({
      name: "pdf",
      args: "report.pdf",
    })
    expect(
      taskOutput(
        tool(
          "BashOutput",
          { bash_id: "b1" },
          {
            output: "<status>running</status>\n<stdout>\nline 1\nline 2\n</stdout>",
          },
        ),
      ),
    ).toEqual({ status: "running", text: "line 1\nline 2" })
  })

  it("splits MCP calls into server, tool, arguments and result", () => {
    const call = mcpCall(
      tool(
        "mcp__context7__get-library-docs",
        { libraryId: "/react" },
        {
          output: JSON.stringify([{ type: "text", text: '{"ok":true}' }]),
        },
      ),
    )
    expect(call).toMatchObject({
      server: "context7",
      tool: "get-library-docs",
      args: { libraryId: "/react" },
      text: '{"ok":true}',
      json: true,
    })
    expect(humanizeName("get-library-docs")).toBe("Get library docs")
  })
})

describe("work groups", () => {
  type Entry = { key: string; tool?: ToolCall }
  const item = (value: ToolCall): Entry => ({ key: value.id, tool: value })
  const toolOf = (entry: Entry) => entry.tool ?? null

  it("folds two or more consecutive lookups or commands and leaves single tools alone", () => {
    const items = [
      item(tool("Read", { file_path: "a" }, { id: "r1" })),
      item(tool("Grep", { pattern: "x" }, { id: "g1" })),
      item(tool("Bash", { command: "rg x" }, { id: "b0" })),
      item(tool("Bash", { command: "pnpm lint" }, { id: "b1" })),
      item(tool("Bash", { command: "pnpm test" }, { id: "b2" })),
      { key: "m1" } as Entry,
      item(tool("Read", { file_path: "b" }, { id: "r2" })),
    ]
    const grouped = groupTools(items, toolOf)
    expect(
      grouped.map((entry) =>
        "tools" in entry ? `${entry.kind}:${entry.tools.length}` : entry.key,
      ),
    ).toEqual(["explore:3", "commands:2", "m1", "r2"])
  })
})
