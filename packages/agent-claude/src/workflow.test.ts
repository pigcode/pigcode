/** 验证工作流：用 Claude Code 2.1.304 的真实录制回放，看卡片快照、后台任务与 run 的结束时机。 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentEvent, WorkflowSnapshot } from "@pigcode/contracts"
import { describe, expect, it } from "vitest"
import { createNormalizeState, normalizeSdkMessage } from "./normalize"
import { scriptMeta } from "./workflow"

/** 录制里的全部 SDK 消息：Ultracode 打开时，Claude 用 Workflow 工具派两个 agent 各审一个文件。 */
const RECORDING = readFileSync(
  fileURLToPath(new URL("./fixtures/workflow.jsonl", import.meta.url)),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as SDKMessage)

/** 回放整段录制，返回规范化后的事件。 */
function replay(messages: readonly SDKMessage[] = RECORDING): AgentEvent[] {
  const state = createNormalizeState()
  return messages.flatMap((message) => normalizeSdkMessage(message, state))
}

/** 工作流快照，按发出的顺序。 */
function snapshots(events: readonly AgentEvent[]): WorkflowSnapshot[] {
  return events.flatMap((event) => (event.type === "workflow.updated" ? [event.workflow] : []))
}

describe("Claude workflows", () => {
  it("draws the Workflow call as a workflow card instead of a tool row", () => {
    const events = replay()
    expect(events.some((event) => event.type === "tool.started")).toBe(false)
    expect(events.some((event) => event.type === "tool.completed")).toBe(false)
    const [first] = snapshots(events)
    expect(first).toMatchObject({
      toolCallId: "toolu_01AYfEP7d59gsMp5nvwsqkCV",
      name: "review-two-files",
      description: "One agent per file (math.js, greet.js) writes a one-sentence review",
      status: "running",
      phases: [],
      agents: [],
    })
    expect(first?.script).toContain("parallel(")
  })

  it("follows phases and agents, and only sends a snapshot when something visible changed", () => {
    const all = snapshots(replay())
    // 录制里有 30 多条 task_progress，大多只是 token 在涨；看得见的变化只有几次。
    expect(all.length).toBeGreaterThan(3)
    expect(all.length).toBeLessThan(12)
    expect(all.slice(1).every((snapshot) => snapshot.script === undefined)).toBe(true)
    const running = all.find((snapshot) =>
      snapshot.agents.some((agent) => agent.state === "running" && agent.activity),
    )
    expect(running?.phases).toEqual([{ index: 1, title: "Review" }])
    expect(running?.agents.map((agent) => agent.label)).toEqual([
      "review:math.js",
      "review:greet.js",
    ])
    expect(running?.agents[0]?.activity).toMatch(/^Read /)
  })

  it("finishes the workflow with each agent's result and the total usage", () => {
    const last = snapshots(replay()).at(-1)
    expect(last?.status).toBe("completed")
    expect(last?.taskId).toBe("wtuye9udr")
    expect(last?.summary).toContain("completed")
    expect(last?.usage).toEqual({ tokens: 64398, toolCalls: 2, durationMs: 20986 })
    expect(last?.agents.map((agent) => [agent.label, agent.state])).toEqual([
      ["review:math.js", "done"],
      ["review:greet.js", "done"],
    ])
    expect(last?.agents[1]?.result).toContain("greet")
    expect(last?.agents[0]?.durationMs).toBeGreaterThan(0)
  })

  it("keeps the run open until the turn Claude Code adds after the workflow ends", () => {
    const events = replay()
    const completed = events.flatMap((event, index) =>
      event.type === "run.completed" ? [index] : [],
    )
    // 主回合在工作流启动后就有了 result，但 run 只在最后续上的回合结束时结束一次。
    expect(completed).toEqual([events.length - 1])
    const replies = events.flatMap((event) =>
      event.type === "message.completed" && !event.parentToolUseId ? [event.text] : [],
    )
    expect(replies.at(0)).toContain("started the workflow")
    expect(replies.at(-1)).toContain("The workflow finished")
    const finished = events.findIndex(
      (event) => event.type === "workflow.updated" && event.workflow.status === "completed",
    )
    expect(finished).toBeLessThan(events.length - 1)
  })

  it("fails the workflow when the Workflow tool itself errors, and does not wait for it", () => {
    const state = createNormalizeState()
    const call = (content: unknown) =>
      ({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content },
      }) as unknown as SDKMessage
    normalizeSdkMessage(
      call([{ type: "tool_use", id: "wf1", name: "Workflow", input: { script: "x" } }]),
      state,
    )
    const events = normalizeSdkMessage(
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "wf1",
              is_error: true,
              content: "Workflows are disabled",
            },
          ],
        },
      } as unknown as SDKMessage,
      state,
    )
    expect(events).toEqual([
      {
        type: "workflow.updated",
        workflow: expect.objectContaining({
          status: "failed",
          summary: "Workflows are disabled",
        }) as WorkflowSnapshot,
      },
    ])
    const ended = normalizeSdkMessage(
      { type: "result", subtype: "success", is_error: false, result: "" } as unknown as SDKMessage,
      state,
    )
    expect(ended.at(-1)).toEqual({ type: "run.completed" })
  })

  it("reads the name and description from the script's meta block", () => {
    expect(
      scriptMeta(
        "export const meta = {\n  name: 'audit',\n  description: \"Check every \\\"route\\\"\",\n}\nawait agent('x')",
      ),
    ).toEqual({ name: "audit", description: 'Check every \\"route\\"' })
    expect(scriptMeta("await agent('no meta')")).toEqual({})
    expect(scriptMeta(undefined)).toEqual({})
  })
})
