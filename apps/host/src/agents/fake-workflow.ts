/**
 * fake agent 的工作流脚本：主 agent 写一段工作流，分两个阶段派出四个 agent，工作流卡片从「准备中」
 * 一路走到全部完成，最后主 agent 汇总。用来在没有真实 Claude Code 的环境里演示和测试工作流卡片。
 * 快照的形状和 Claude driver 从真实录制里映射出来的一样。
 */
import type { WorkflowAgent, WorkflowSnapshot } from "@pigcode/contracts"
import { message, type Step } from "./fake-script"

/** 触发工作流脚本的输入。 */
export const FAKE_WORKFLOW_TEXT = "workflow"

const TOOL_CALL = "fake-workflow"

const SCRIPT = `export const meta = {
  name: 'audit-exports',
  description: '逐个文件检查导出，再汇总成一份清单',
  phases: [{ title: '检查文件' }, { title: '汇总' }],
}
const FILES = ['src/index.ts', 'src/math.ts', 'src/greet.ts']
const reviews = await parallel(FILES.map((file) => () =>
  agent(\`读 \${file}，列出它导出的名字和用途\`, { label: \`check:\${file}\`, phase: '检查文件' })))
return agent(\`把这些结果汇总成一份导出清单：\${JSON.stringify(reviews)}\`, { label: 'summary', phase: '汇总' })
`

const PHASES: WorkflowSnapshot["phases"] = [
  { index: 1, title: "检查文件" },
  { index: 2, title: "汇总" },
]

/** 检查一个文件的 agent。 */
function checker(index: number, file: string, patch: Partial<WorkflowAgent>): WorkflowAgent {
  return {
    index,
    label: `check:${file}`,
    phase: "检查文件",
    state: "running",
    model: "claude-opus-5-5",
    prompt: `读 ${file}，列出它导出的名字和用途`,
    ...patch,
  }
}

/** 工作流在某一时刻的快照。 */
function snapshot(patch: Partial<WorkflowSnapshot>): Step {
  return {
    type: "workflow.updated",
    workflow: {
      toolCallId: TOOL_CALL,
      taskId: "fake-task",
      name: "audit-exports",
      description: "逐个文件检查导出，再汇总成一份清单",
      status: "running",
      phases: PHASES,
      agents: [],
      ...patch,
    },
  }
}

/** 完整脚本；stepMs 控制每一步的间隔，测试传 0。 */
export function fakeWorkflowScript(stepMs: number): Step[] {
  const indexDone = checker(1, "src/index.ts", {
    state: "done",
    durationMs: 8200,
    tokens: 31200,
    toolCalls: 1,
    result: "导出 `answer`（= 42），由 `base + 1` 计算。",
  })
  const mathDone = checker(2, "src/math.ts", {
    state: "done",
    durationMs: 11400,
    tokens: 32800,
    toolCalls: 2,
    result: "导出 `add(a, b)`，没有校验参数类型，`add('1', 2)` 会得到 `'12'`。",
  })
  const greetDone = checker(3, "src/greet.ts", {
    state: "done",
    durationMs: 9700,
    tokens: 30900,
    toolCalls: 1,
    result: "导出 `greet(name)`，没传名字时返回 `hi undefined`。",
  })
  const summary: WorkflowAgent = {
    index: 4,
    label: "summary",
    phase: "汇总",
    state: "queued",
    model: "claude-opus-5-5",
    prompt: "把这些结果汇总成一份导出清单",
  }
  return [
    ...message("我用一个工作流并行检查三个文件的导出，最后汇总。"),
    { ...snapshot({ phases: [], script: SCRIPT }) },
    { wait: stepMs },
    snapshot({
      agents: [
        checker(1, "src/index.ts", { activity: "Read src/index.ts" }),
        checker(2, "src/math.ts", { activity: "Read src/math.ts" }),
        checker(3, "src/greet.ts", { state: "queued" }),
        summary,
      ],
    }),
    { wait: stepMs },
    snapshot({
      agents: [
        indexDone,
        checker(2, "src/math.ts", { activity: "Grep add( src" }),
        checker(3, "src/greet.ts", { activity: "Read src/greet.ts" }),
        summary,
      ],
    }),
    { wait: stepMs },
    snapshot({
      agents: [
        indexDone,
        mathDone,
        greetDone,
        { ...summary, state: "running", activity: "整理三份结果" },
      ],
    }),
    { wait: stepMs },
    snapshot({
      status: "completed",
      agents: [
        indexDone,
        mathDone,
        greetDone,
        {
          ...summary,
          state: "done",
          durationMs: 6100,
          tokens: 12400,
          result: "三个文件共导出 `answer`、`add`、`greet`；`add` 缺参数校验，`greet` 缺默认名字。",
        },
      ],
      usage: { tokens: 107300, toolCalls: 4, durationMs: 23800 },
      summary: "Dynamic workflow completed",
    }),
    ...message(
      "工作流完成了：\n\n- `answer`（42）没有问题\n- `add` 没有校验参数类型\n- `greet` 没传名字时会输出 `hi undefined`",
    ),
  ]
}
