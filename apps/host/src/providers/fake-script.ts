/**
 * fake provider 的脚本化回复：一轮里依次出现说明、计划、读文件、搜索、改文件、跑命令和总结，
 * 用来在没有真实 CLI 的环境里演示与测试时间线（工作分组、工具行、计划卡片）。
 */
import type { ProviderEvent } from "@pigcode/contracts"
import type { ProviderRuntime } from "./driver"

/** 触发脚本化回复的输入。 */
export const FAKE_SCRIPT_TEXT = "tools"

/** 脚本里的一步：事件，或者等待。 */
export type Step = ProviderEvent | { wait: number }

export function message(text: string): Step[] {
  const words = text.split(/(?<=\s)/)
  return [
    ...words.map((word): Step => ({ type: "message.delta", text: word })),
    { type: "message.completed", text },
  ]
}

export function tool(
  id: string,
  name: string,
  input: unknown,
  output: unknown,
  waitMs: number,
): Step[] {
  return [
    { type: "tool.started", toolCallId: id, name, input },
    { wait: waitMs },
    { type: "tool.completed", toolCallId: id, name, output, isError: false },
  ]
}

/** 跑一条命令：输出分几段流出来，最后带完整输出与退出码结束。 */
export function command(
  id: string,
  cmd: string,
  chunks: string[],
  waitMs: number,
  exitCode = 0,
): Step[] {
  return [
    { type: "tool.started", toolCallId: id, name: "Bash", input: { command: cmd } },
    ...chunks.flatMap((delta): Step[] => [
      { wait: waitMs },
      { type: "tool.outputDelta", toolCallId: id, delta },
    ]),
    { wait: waitMs },
    {
      type: "tool.completed",
      toolCallId: id,
      name: "Bash",
      output: chunks.join(""),
      isError: exitCode !== 0,
      exitCode,
    },
  ]
}

const LINT_OUTPUT = [
  "\n> demo@0.0.0 lint\n> eslint src\n\n",
  "src/index.ts\n  1:24  error  Unexpected constant binary expression  no-constant-binary-expression\n\n",
  "✖ 1 problem (1 error, 0 warnings)\n",
]

const TEST_OUTPUT = [
  "\n> demo@0.0.0 test\n> vitest run\n\n",
  " ✓ src/index.test.ts > answer is 42\n",
  " ✓ src/index.test.ts > answer is a number\n",
  " ✓ src/index.test.ts > answer is exported\n",
  "\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration  412ms\n",
]

/** 完整脚本；stepMs 控制每个工具的耗时，测试传 0。 */
export function fakeScript(stepMs: number): Step[] {
  return [
    ...message("先看一下项目结构和测试入口。"),
    {
      type: "plan.updated",
      explanation: "检查并修复示例项目",
      plan: [
        { step: "阅读 README 与入口文件", status: "in_progress" },
        { step: "修改 answer 的实现", status: "pending" },
        { step: "运行测试", status: "pending" },
      ],
    },
    ...tool("fake-read-1", "Read", { file_path: "README.md" }, "# Demo\n", stepMs),
    ...tool(
      "fake-read-2",
      "Read",
      { file_path: "src/index.ts" },
      "export const answer = 42\n",
      stepMs,
    ),
    ...tool("fake-grep-1", "Grep", { pattern: "answer", path: "src" }, "src/index.ts:1", stepMs),
    {
      type: "plan.updated",
      explanation: "检查并修复示例项目",
      plan: [
        { step: "阅读 README 与入口文件", status: "completed" },
        { step: "修改 answer 的实现", status: "in_progress" },
        { step: "运行测试", status: "pending" },
      ],
    },
    ...tool(
      "fake-edit-1",
      "Edit",
      { file_path: "src/index.ts", old_string: "42", new_string: "41 + 1" },
      "The file src/index.ts has been updated.",
      stepMs,
    ),
    ...command("fake-lint-1", "pnpm lint", LINT_OUTPUT, stepMs / 3, 1),
    ...message("lint 不接受常量表达式，换成先声明再导出。"),
    ...tool(
      "fake-edit-2",
      "Edit",
      {
        file_path: "src/index.ts",
        old_string: "export const answer = 41 + 1",
        new_string: "const base = 41\nexport const answer = base + 1",
      },
      "The file src/index.ts has been updated.",
      stepMs,
    ),
    ...command("fake-bash-1", "pnpm lint && pnpm test", TEST_OUTPUT, stepMs / 2),
    {
      type: "plan.updated",
      explanation: "检查并修复示例项目",
      plan: [
        { step: "阅读 README 与入口文件", status: "completed" },
        { step: "修改 answer 的实现", status: "completed" },
        { step: "运行测试", status: "completed" },
      ],
    },
    ...message(
      "改好了：`answer` 现在由 `base + 1` 计算，结果仍是 **42**。\n\n- 修改了 `src/index.ts`\n- `pnpm lint` 与 `pnpm test` 全部通过",
    ),
  ]
}

/** 触发派生子 agent 脚本的输入。 */
export const FAKE_SUBAGENT_TEXT = "subagents"

function childTool(
  parent: string,
  id: string,
  name: string,
  input: unknown,
  output: unknown,
): Step[] {
  return [
    { type: "tool.started", toolCallId: id, name, input, parentToolUseId: parent },
    {
      type: "tool.completed",
      toolCallId: id,
      name,
      output,
      isError: false,
      parentToolUseId: parent,
    },
  ]
}

/** 主 agent 并行派生两个子 agent：一个查代码，一个跑测试，各自交回结果后主 agent 总结。 */
export function fakeSubagentScript(stepMs: number): Step[] {
  const explore = "fake-task-explore"
  const review = "fake-task-review"
  return [
    ...message("我让两个子代理并行处理：一个梳理入口，一个检查测试。"),
    {
      type: "subagent.started",
      toolCallId: explore,
      name: "Explore",
      description: "梳理入口与导出",
      prompt: "阅读 src/index.ts 和 README.md，列出项目对外导出的内容，以及 answer 的计算方式。",
    },
    {
      type: "subagent.started",
      toolCallId: review,
      name: "general-purpose",
      description: "检查测试覆盖",
      prompt: "运行 pnpm test，说明哪些行为有测试覆盖，哪些没有。",
    },
    { wait: stepMs },
    ...childTool(
      explore,
      "fake-explore-read",
      "Read",
      { file_path: "src/index.ts" },
      "export const answer = 42\n",
    ),
    {
      type: "message.completed",
      text: "入口只导出了一个常量 `answer`。",
      parentToolUseId: explore,
    },
    { wait: stepMs },
    ...childTool(
      review,
      "fake-review-bash",
      "Bash",
      { command: "pnpm test" },
      "Tests  3 passed (3)\n",
    ),
    { wait: stepMs },
    ...childTool(explore, "fake-explore-read-2", "Read", { file_path: "README.md" }, "# Demo\n"),
    {
      type: "subagent.completed",
      toolCallId: explore,
      isError: false,
      status: "completed",
      output: "导出：`answer`（= 42）。README 只有标题，没有用法说明。",
    },
    { wait: stepMs },
    {
      type: "message.completed",
      text: "3 个测试都覆盖 `answer` 的值，没有覆盖导出形状。",
      parentToolUseId: review,
    },
    {
      type: "subagent.completed",
      toolCallId: review,
      isError: false,
      status: "completed",
      output: "`pnpm test` 3 个通过；缺少对导出形状的测试。",
    },
    ...message(
      "两个子代理都完成了：\n\n- 入口只导出 `answer`（42），README 缺少用法说明\n- 测试 3 个通过，但没有覆盖导出形状",
    ),
  ]
}

/** 依次推送脚本；中断后立即停止。 */
export async function runFakeScript(
  runtime: ProviderRuntime,
  stepMs: number,
  script: (stepMs: number) => Step[] = fakeScript,
): Promise<void> {
  for (const step of script(stepMs)) {
    if (runtime.signal.aborted) return
    if ("wait" in step) {
      if (step.wait > 0) await new Promise((resolve) => setTimeout(resolve, step.wait))
      continue
    }
    runtime.emit(step)
    // 逐字增量之间稍作停顿，界面上能看到流式输出。
    if (step.type === "message.delta" && stepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(40, stepMs / 10)))
    }
  }
}
