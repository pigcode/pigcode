/**
 * fake agent 的全工具演示：思考、查阅、待办、编辑与新建文件、终端命令（含失败与后台任务）、
 * 网页搜索与抓取、技能、MCP 工具、提问、计划、子 agent，最后是一段带表格与代码块的回答。
 * 用来在没有真实 CLI 的环境里演示与测试每一种工具在时间线里的样子。
 */
import { command, message, tool, type Step } from "./fake-script"

/** 触发全工具演示的输入。 */
export const FAKE_SHOWCASE_TEXT = "showcase"

function thinking(text: string, waitMs: number): Step[] {
  const words = text.split(/(?<=[，。,.\s])/)
  return [
    ...words.flatMap((word): Step[] => [
      { type: "reasoning.delta", text: word },
      { wait: Math.min(30, waitMs / 6) },
    ]),
    { type: "reasoning.completed", text },
  ]
}

function failedTool(
  id: string,
  name: string,
  input: unknown,
  error: string,
  waitMs: number,
): Step[] {
  return [
    { type: "tool.started", toolCallId: id, name, input },
    { wait: waitMs },
    { type: "tool.completed", toolCallId: id, name, output: error, isError: true },
  ]
}

const TODOS = (done: number) =>
  ["梳理入口与格式化逻辑", "抽出 formatAnswer 并补测试", "跑 lint 与测试", "更新 README 用法"].map(
    (content, index) => ({
      content,
      activeForm: content,
      status: index < done ? "completed" : index === done ? "in_progress" : "pending",
    }),
  )

const LINT_FAIL = [
  "\n> demo@0.0.0 lint\n> eslint src\n\n",
  "src/format.ts\n  3:10  error  'value' is defined but never used  no-unused-vars\n\n",
  "✖ 1 problem (1 error, 0 warnings)\n",
]

const TEST_PASS = [
  "\n> demo@0.0.0 test\n> vitest run\n\n",
  " ✓ src/format.test.ts (2 tests) 3ms\n",
  " ✓ src/index.test.ts (3 tests) 2ms\n",
  "\n Test Files  2 passed (2)\n      Tests  5 passed (5)\n",
]

const PLAN = `## 抽出格式化逻辑

1. 新建 \`src/format.ts\`，导出 \`formatAnswer(value: number): string\`
2. \`src/index.ts\` 改用它，保持对外导出不变
3. 为 \`formatAnswer\` 补两条测试，跑 lint 与测试`

const SUMMARY = `完成了，格式化逻辑已经抽到 \`src/format.ts\`：

### 改动

| 文件 | 改动 |
| --- | --- |
| \`src/format.ts\` | 新建，导出 \`formatAnswer\` |
| \`src/index.ts\` | 改用 \`formatAnswer\` |
| \`src/format.test.ts\` | 新增 2 条测试 |

\`\`\`ts
export function formatAnswer(value: number): string {
  return \`The answer is \${value}\`
}
\`\`\`

- [x] lint 通过
- [x] 5 个测试全部通过
- [ ] README 的用法说明留到下一步

> 参考了 [Vitest 文档](https://vitest.dev/guide/) 里内联快照的写法。`

/** 全工具演示脚本；stepMs 控制每一步的耗时，测试传 0。 */
export function fakeShowcaseScript(stepMs: number): Step[] {
  return [
    ...thinking(
      "用户想看完整的一轮工作。先弄清楚入口和格式化逻辑在哪里，再决定怎么拆，最后跑测试确认。",
      stepMs,
    ),
    ...message("先看一下项目结构和现有的格式化逻辑。"),
    ...tool("show-read-1", "Read", { file_path: "README.md" }, "# Demo\n", stepMs),
    ...tool(
      "show-glob-1",
      "Glob",
      { pattern: "src/**/*.ts" },
      "src/index.ts\nsrc/index.test.ts",
      stepMs,
    ),
    ...tool(
      "show-grep-1",
      "Grep",
      { pattern: "answer", path: "src" },
      "src/index.ts:1:export const answer = 42",
      stepMs,
    ),
    ...tool(
      "show-read-2",
      "Read",
      { file_path: "src/index.ts", offset: 1, limit: 40 },
      "export const answer = 42\n",
      stepMs,
    ),
    ...command("show-git-1", "git status --short", [" M src/index.ts\n"], stepMs / 3),
    ...failedTool(
      "show-read-3",
      "Read",
      { file_path: "src/format.ts" },
      "File does not exist. Current working directory: /tmp/demo",
      stepMs,
    ),
    ...tool("show-todo-1", "TodoWrite", { todos: TODOS(1) }, "Todos have been modified", 0),
    ...thinking("格式化逻辑写死在入口里。抽成独立函数，入口只负责导出。", stepMs),
    ...tool(
      "show-plan-1",
      "ExitPlanMode",
      { plan: PLAN },
      "User has approved your plan. You can now start coding.",
      stepMs,
    ),
    ...tool(
      "show-write-1",
      "Write",
      {
        file_path: "src/format.ts",
        content:
          "export function formatAnswer(value: number): string {\n  const value2 = value\n  return `The answer is ${value}`\n}\n",
      },
      "File created successfully at: src/format.ts",
      stepMs,
    ),
    ...tool(
      "show-edit-1",
      "Edit",
      {
        file_path: "src/index.ts",
        old_string: "export const answer = 42",
        new_string:
          'import { formatAnswer } from "./format"\n\nexport const answer = 42\nexport const label = formatAnswer(answer)',
      },
      "The file src/index.ts has been updated.",
      stepMs,
    ),
    ...command("show-lint-1", "pnpm lint", LINT_FAIL, stepMs / 3, 1),
    ...message("lint 报了一个未使用的变量，去掉它。"),
    ...tool(
      "show-multi-1",
      "MultiEdit",
      {
        file_path: "src/format.ts",
        edits: [
          { old_string: "  const value2 = value\n", new_string: "" },
          { old_string: "The answer is", new_string: "The answer is" },
        ],
      },
      "Applied 2 edits to src/format.ts",
      stepMs,
    ),
    ...tool(
      "show-write-2",
      "Write",
      {
        file_path: "src/format.test.ts",
        content:
          'import { expect, it } from "vitest"\nimport { formatAnswer } from "./format"\n\nit("formats", () => {\n  expect(formatAnswer(42)).toBe("The answer is 42")\n})\n\nit("handles zero", () => {\n  expect(formatAnswer(0)).toBe("The answer is 0")\n})\n',
      },
      "File created successfully at: src/format.test.ts",
      stepMs,
    ),
    ...tool("show-todo-2", "TodoWrite", { todos: TODOS(2) }, "Todos have been modified", 0),
    ...command("show-test-1", "pnpm lint && pnpm test", TEST_PASS, stepMs / 3),
    ...command("show-diff-1", "pnpm exec tsc --noEmit", [], stepMs / 3),
    ...tool(
      "show-dev-1",
      "Bash",
      { command: "pnpm dev", run_in_background: true, description: "启动开发服务器" },
      "Command running in background with ID: shell_1",
      stepMs,
    ),
    ...tool(
      "show-out-1",
      "BashOutput",
      { bash_id: "shell_1" },
      "<status>running</status>\n<stdout>\n  VITE v7.1.0  ready in 312 ms\n  ➜  Local:   http://localhost:5173/\n</stdout>",
      stepMs,
    ),
    ...tool(
      "show-kill-1",
      "KillShell",
      { shell_id: "shell_1" },
      '{"message":"Successfully killed shell: shell_1 (pnpm dev)","shell_id":"shell_1"}',
      stepMs,
    ),
    ...tool(
      "show-search-1",
      "WebSearch",
      { query: "vitest inline snapshot" },
      "Links: [Snapshot | Guide | Vitest](https://vitest.dev/guide/snapshot)",
      stepMs,
    ),
    ...tool(
      "show-fetch-1",
      "WebFetch",
      { url: "https://vitest.dev/guide/snapshot", prompt: "How do inline snapshots work?" },
      "Inline snapshots store the expected value right in the test file via toMatchInlineSnapshot().",
      stepMs,
    ),
    ...tool(
      "show-skill-1",
      "Skill",
      { skill: "write-tests", args: "src/format.ts" },
      "Loaded skill write-tests: prefer table-driven tests and inline snapshots.",
      stepMs,
    ),
    ...tool(
      "show-mcp-1",
      "mcp__context7__get-library-docs",
      { context7CompatibleLibraryID: "/vitest-dev/vitest", topic: "inline snapshot", tokens: 2000 },
      [
        {
          type: "text",
          text: '{\n  "library": "/vitest-dev/vitest",\n  "topic": "inline snapshot",\n  "snippets": 3\n}',
        },
      ],
      stepMs,
    ),
    {
      type: "subagent.started",
      toolCallId: "show-task-1",
      name: "Explore",
      description: "检查 README 是否需要更新",
      prompt: "读一下 README.md，判断需不需要补充 formatAnswer 的用法说明。",
    },
    { wait: stepMs },
    {
      type: "tool.started",
      toolCallId: "show-task-read",
      name: "Read",
      input: { file_path: "README.md" },
      parentToolUseId: "show-task-1",
    },
    {
      type: "tool.completed",
      toolCallId: "show-task-read",
      name: "Read",
      output: "# Demo\n",
      isError: false,
      parentToolUseId: "show-task-1",
    },
    {
      type: "subagent.completed",
      toolCallId: "show-task-1",
      isError: false,
      status: "completed",
      output: "README 只有标题，建议补一段 formatAnswer 的用法。",
    },
    ...message(SUMMARY),
  ]
}
