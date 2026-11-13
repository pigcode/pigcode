/** 用 replay query 驱动 driver，验证事件顺序与审批。 */
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { SessionMcp } from "@pigcode/plugin-sdk"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { withCliStderr } from "./cli-process"
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
    const session = await driver.createSession({
      threadId: "t6",
      cwd: "/tmp",
      permissionMode: "approval-required",
    })
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

/** 用真实 SDK 启动一个假的 CLI：它启动一个孙进程，把 pid 写到文件里，然后一直等着。 */
describe("ClaudeDriver process lifetime", () => {
  /** 写一个假 CLI 并开始一次 send；返回 driver、session 和这次 send 的结果。 */
  async function startFakeCli(script: string) {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-claude-tree-"))
    const cli = join(dir, "fake-claude.js")
    const pidFile = join(dir, "tool.pid")
    await writeFile(cli, script.replace("PID_FILE", JSON.stringify(pidFile)))
    const driver = new ClaudeDriver({ executable: cli })
    const session = await driver.createSession({ threadId: "t1", cwd: dir })
    const failures: string[] = []
    const sent = driver.send(
      session,
      { text: "hello" },
      {
        signal: new AbortController().signal,
        emit: (event) => {
          if (event.type === "run.failed") failures.push(event.message)
        },
        requestApproval: async () => "allow-once",
      },
    )
    return { driver, session, sent, failures, pidFile }
  }

  // 和真实的 Claude Code 一样，Bash 工具放在自己的 session 里，不在 CLI 的进程组内；还要忽略 SIGTERM，
  // 这样只有强制结束那一步才能结束它。
  const HANGING_CLI = `
    const { spawn } = require("node:child_process")
    const { writeFileSync } = require("node:fs")
    const script = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    const tool = spawn(process.execPath, ["-e", script], { stdio: "ignore", detached: true })
    setTimeout(() => writeFileSync(PID_FILE, String(tool.pid)), 200)
    process.stdin.resume()
    process.stdin.on("end", () => {})
    setInterval(() => {}, 1000)
  `

  /** 等假 CLI 写好孙进程的 pid。 */
  async function toolPid(pidFile: string): Promise<number> {
    return vi.waitFor(async () => Number(await readFile(pidFile, "utf8")), {
      timeout: 10000,
      interval: 25,
    })
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it("has ended the CLI and its tools by the time close resolves", { timeout: 30000 }, async () => {
    const { driver, sent, pidFile } = await startFakeCli(HANGING_CLI)
    const pid = await toolPid(pidFile)
    expect(isAlive(pid)).toBe(true)
    await driver.close()
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 3000, interval: 25 })
    await sent
  })

  it("ends the CLI and its tools when the session is disposed", { timeout: 30000 }, async () => {
    const { driver, session, sent, pidFile } = await startFakeCli(HANGING_CLI)
    const pid = await toolPid(pidFile)
    await driver.dispose(session)
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 3000, interval: 25 })
    await sent
  })

  // 注销 driver 时注册表先 dispose 活跃会话，不等结果，接着插件才 await close；Host 紧接着就退出。
  it("close also waits for a dispose nobody awaited", { timeout: 30000 }, async () => {
    const { driver, session, sent, pidFile } = await startFakeCli(HANGING_CLI)
    const pid = await toolPid(pidFile)
    void driver.dispose(session)
    await driver.close()
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 3000, interval: 25 })
    await sent
  })

  it("still tells the user what the CLI wrote to stderr when it fails", async () => {
    const { sent, failures } = await startFakeCli(`
      process.stderr.write("Not logged in: run claude login\\n")
      process.exit(3)
    `)
    await sent
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain("Not logged in: run claude login")
  })

  it("adds stderr only to errors about the process exiting", () => {
    expect(withCliStderr("Claude Code process exited with code 1", "boom")).toBe(
      "Claude Code process exited with code 1: boom",
    )
    expect(withCliStderr("Claude Code returned an error result: nope", "a warning")).toBe(
      "Claude Code returned an error result: nope",
    )
    expect(withCliStderr("Claude Code process exited with code 1", "")).toBe(
      "Claude Code process exited with code 1",
    )
  })

  it("does not lose stderr that is still being written when the CLI exits", async () => {
    const { sent, failures } = await startFakeCli(`
      process.stderr.write("x".repeat(200000) + "the real reason\\n", () => process.exit(3))
    `)
    await sent
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain("the real reason")
  })
})
