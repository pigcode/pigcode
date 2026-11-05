/** 验证 Codex 调用 MCP 工具前的 elicitation：工具审批走审批流程，别的请求一律拒绝。 */
import { describe, expect, it } from "vitest"
import type { AgentRuntime, ApprovalDecision, ApprovalRequest } from "@pigcode/plugin-sdk"
import { CodexDriver } from "./driver"
import { ScriptedTransport, sentMessages } from "./scripted-transport"

/** 轮询到条件成立，避免依赖固定 sleep。 */
async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("condition not met")
}

describe("CodexDriver MCP elicitation", () => {
  /** 跑一轮：app-server 中途发来一条 MCP elicitation，返回 driver 的答复和收到的审批请求。 */
  async function answerElicitation(
    params: unknown,
    decision: ApprovalDecision,
  ): Promise<{ result: unknown; approvals: ApprovalRequest[] }> {
    const transport = new ScriptedTransport({
      nativeThreadId: "th_native",
      onTurnStart: (message, replay) => {
        replay.push({ id: message.id, result: { turn: { id: "turn_1" } } })
        setTimeout(() => {
          replay.push({ id: 0, method: "mcpServer/elicitation/request", params })
        }, 0)
      },
    })
    const driver = new CodexDriver({ transportFactory: () => transport })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    const approvals: ApprovalRequest[] = []
    const runtime: AgentRuntime = {
      signal: new AbortController().signal,
      emit: () => undefined,
      requestApproval: async (request) => {
        approvals.push(request)
        return decision
      },
    }
    const send = driver.send(session, { text: "run" }, runtime)
    await waitFor(() => sentMessages(transport).some((message) => message.id === 0))
    const result = sentMessages(transport).find((message) => message.id === 0)?.result
    transport.push({
      method: "turn/completed",
      params: { threadId: "th_native", turn: { id: "turn_1", status: "completed" } },
    })
    await send
    return { result, approvals }
  }

  // Codex 调用 MCP 工具前会发这条请求；不答复的话它把工具调用当成用户拒绝。
  const toolApproval = {
    threadId: "th_native",
    turnId: "turn_1",
    serverName: "pigcode",
    mode: "form",
    message: 'Allow the pigcode MCP server to run tool "secret_value"?',
    requestedSchema: { type: "object", properties: {} },
    _meta: {
      codex_approval_kind: "mcp_tool_call",
      persist: ["session", "always"],
      tool_description: "Return the secret value",
      tool_params: { key: "a" },
    },
  }

  it.each<[ApprovalDecision, unknown]>([
    ["allow-once", { action: "accept", content: {} }],
    ["allow-for-session", { action: "accept", content: {}, _meta: { persist: "session" } }],
    ["deny", { action: "decline" }],
  ])("answers an MCP tool approval with %s", async (decision, expected) => {
    const { result, approvals } = await answerElicitation(toolApproval, decision)
    expect(result).toEqual(expected)
    expect(approvals).toEqual([
      {
        toolName: "mcp__pigcode__secret_value",
        input: { key: "a" },
        description: "Return the secret value",
      },
    ])
  })

  // 审批卡片填不了表单，也打不开链接：明确拒绝，不能当成批准。
  it("declines an elicitation that asks the user for something else", async () => {
    const { result, approvals } = await answerElicitation(
      {
        threadId: "th_native",
        serverName: "other",
        mode: "url",
        elicitationId: "e1",
        message: "Sign in",
        url: "https://example.com",
      },
      "allow-once",
    )
    expect(result).toEqual({ action: "decline" })
    expect(approvals).toEqual([])
  })
})
