/** 用 replay query 驱动 driver，验证事件顺序与审批。 */
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { SessionMcp } from "@pigcode/plugin-sdk"
import { describe, expect, it } from "vitest"
import { ClaudeDriver } from "./driver"
import { replayQuery } from "./replay"

/** 只有一个 echo 工具的会话 MCP。 */
function echoMcp(): SessionMcp {
  return {
    tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } }],
    callTool: async (_name, input) => input,
    stdioServer: () => ({ command: "node", args: [], env: {} }),
  }
}

describe("ClaudeDriver", () => {
  it("emits deltas, tool events, usage, and completion", async () => {
    const events: string[] = []
    const driver = new ClaudeDriver({ queryFn: replayQuery("fixtures/simple.jsonl") })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    await driver.send(
      session,
      { text: "hello" },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event.type),
        requestApproval: async () => "allow-once",
      },
    )
    expect(events).toContain("message.delta")
    expect(events).toContain("message.completed")
    expect(events).toContain("usage.updated")
    expect(events).toContain("run.completed")
  })

  it("replays tool use and tool result in order", async () => {
    const events: string[] = []
    let approvalCalls = 0
    const driver = new ClaudeDriver({ queryFn: replayQuery("fixtures/tool-approval.jsonl") })
    const session = await driver.createSession({ threadId: "t2", cwd: "/tmp" })
    await driver.send(
      session,
      { text: "run a command" },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event.type),
        requestApproval: async () => {
          approvalCalls += 1
          return "allow-once"
        },
      },
    )
    expect(events).toContain("tool.started")
    expect(events).toContain("tool.completed")
    expect(events).toContain("run.completed")
    expect(events.indexOf("tool.started")).toBeLessThan(events.indexOf("tool.completed"))
    // replay 不经过 SDK 的 canUseTool，审批回调不会触发。
    expect(approvalCalls).toBe(0)
  })

  it("forwards subagent text to the SDK", async () => {
    let captured: Options | undefined
    const replay = replayQuery("fixtures/simple.jsonl")
    const driver = new ClaudeDriver({
      queryFn: (params) => {
        captured = params.options
        return replay(params)
      },
    })
    const session = await driver.createSession({ threadId: "t4", cwd: "/tmp" })
    await driver.send(
      session,
      { text: "hello" },
      {
        signal: new AbortController().signal,
        emit: () => undefined,
        requestApproval: async () => "allow-once",
      },
    )
    expect(captured?.forwardSubagentText).toBe(true)
  })

  it("injects the thread MCP server into query options", async () => {
    let captured: Options | undefined
    const replay = replayQuery("fixtures/simple.jsonl")
    const driver = new ClaudeDriver({
      queryFn: (params) => {
        captured = params.options
        return replay(params)
      },
    })
    const session = await driver.createSession({
      threadId: "t5",
      cwd: "/tmp",
      mcp: echoMcp(),
    })
    await driver.send(
      session,
      { text: "hello" },
      {
        signal: new AbortController().signal,
        emit: () => undefined,
        requestApproval: async () => "allow-once",
      },
    )
    // 插件工具以进程内 MCP server 形式挂到 SDK 的 mcpServers 上。
    expect(captured?.mcpServers?.pigcode).toMatchObject({ type: "sdk", name: "pigcode" })
  })

  it("refreshes MCP tools when a session id is reused", async () => {
    let captured: Options | undefined
    const replay = replayQuery("fixtures/simple.jsonl")
    const driver = new ClaudeDriver({
      queryFn: (params) => {
        captured = params.options
        return replay(params)
      },
    })
    await driver.createSession({
      threadId: "t6",
      cwd: "/tmp",
      sessionId: "ps_1",
      mcp: echoMcp(),
    })
    // 插件停用后再建会话时没有工具了，复用同一个会话 id 也不能留着旧的 server。
    const session = await driver.createSession({
      threadId: "t6",
      cwd: "/tmp",
      sessionId: "ps_1",
    })
    await driver.send(
      session,
      { text: "hello" },
      {
        signal: new AbortController().signal,
        emit: () => undefined,
        requestApproval: async () => "allow-once",
      },
    )

    expect(session.id).toBe("ps_1")
    expect(captured?.mcpServers).toBeUndefined()
  })

  it("forks the native session instead of continuing it", async () => {
    let captured: Options | undefined
    const replay = replayQuery("fixtures/simple.jsonl")
    const driver = new ClaudeDriver({
      queryFn: (params) => {
        captured = params.options
        return replay(params)
      },
    })
    const session = await driver.createSession({
      threadId: "t6",
      cwd: "/tmp",
      nativeSessionId: "session_parent",
      forkFromNativeSessionId: "session_parent",
    })
    // fork 会生成新的原生会话，创建时不能沿用父会话 id。
    expect(session.nativeSessionId).toBeNull()

    await driver.send(
      session,
      { text: "hello" },
      {
        signal: new AbortController().signal,
        emit: () => undefined,
        requestApproval: async () => "allow-once",
      },
    )

    expect(captured).toMatchObject({ resume: "session_parent", forkSession: true })
  })

  it("passes dontAsk permission mode through to the SDK", async () => {
    let captured: Options | undefined
    const replay = replayQuery("fixtures/simple.jsonl")
    const driver = new ClaudeDriver({
      queryFn: (params) => {
        captured = params.options
        return replay(params)
      },
    })
    const session = await driver.createSession({
      threadId: "t3",
      cwd: "/tmp",
      permissionMode: "dontAsk",
    })
    await driver.send(
      session,
      { text: "hello" },
      {
        signal: new AbortController().signal,
        emit: () => undefined,
        requestApproval: async () => "allow-once",
      },
    )
    // 真实冒烟依赖 dontAsk：不弹权限提示，未预授权的工具直接拒绝。
    expect(captured?.permissionMode).toBe("dontAsk")
  })

  it("answers AskUserQuestion with the user's choices instead of asking for approval", async () => {
    let captured: Options | undefined
    const replay = replayQuery("fixtures/simple.jsonl")
    const driver = new ClaudeDriver({
      queryFn: (params) => {
        captured = params.options
        return replay(params)
      },
    })
    const session = await driver.createSession({ threadId: "t6", cwd: "/tmp" })
    const approvals: string[] = []
    const asked: unknown[] = []
    let answers: string[] = ["pnpm", "lint, test"]
    await driver.send(
      session,
      { text: "hello" },
      {
        signal: new AbortController().signal,
        emit: () => undefined,
        requestApproval: async (request) => {
          approvals.push(request.toolName)
          return "allow-once"
        },
        askQuestions: async (request) => {
          asked.push(request.questions.map((question) => question.question))
          return answers
        },
      },
    )
    const input = {
      questions: [
        {
          question: "用哪个包管理器？",
          header: "工具",
          options: [{ label: "pnpm" }],
          multiSelect: false,
        },
        {
          question: "要哪些检查？",
          header: "检查",
          options: [{ label: "lint" }],
          multiSelect: true,
        },
      ],
    }
    const options = {
      signal: new AbortController().signal,
      toolUseID: "tool_1",
    } as Parameters<NonNullable<Options["canUseTool"]>>[2]
    await expect(captured?.canUseTool?.("AskUserQuestion", input, options)).resolves.toEqual({
      behavior: "allow",
      updatedInput: {
        ...input,
        answers: { "用哪个包管理器？": "pnpm", "要哪些检查？": "lint, test" },
      },
    })
    expect(asked).toEqual([["用哪个包管理器？", "要哪些检查？"]])
    expect(approvals).toEqual([])
    answers = []
    await expect(captured?.canUseTool?.("AskUserQuestion", input, options)).resolves.toMatchObject({
      behavior: "deny",
    })
    // 其他工具仍然走审批。
    await captured?.canUseTool?.("Bash", { command: "ls" }, options)
    expect(approvals).toEqual(["Bash"])
  })
})
