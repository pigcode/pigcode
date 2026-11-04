import { describe, expect, it } from "vitest"
import type { AgentEvent } from "@pigcode/contracts"
import type { AgentRuntime } from "./driver"
import {
  FAKE_MODELS,
  FAKE_SCRIPT_TEXT,
  FAKE_SHOWCASE_TEXT,
  FAKE_TOOL_RENDERERS_TEXT,
  FAKE_SUBAGENT_TEXT,
  FakeAgentDriver,
} from "./fake"
import { FAKE_BROWSER_PREFIX } from "./fake-browser"

describe("fake agent", () => {
  it("streams a deterministic response", async () => {
    const driver = new FakeAgentDriver()
    const session = await driver.createSession({ threadId: "th_1", cwd: "/tmp" })
    const events: string[] = []
    const runtime: AgentRuntime = {
      signal: new AbortController().signal,
      emit: (event: AgentEvent) => events.push(event.type),
      requestApproval: async () => "deny",
    }
    await driver.send(session, { text: "hello" }, runtime)
    expect(events).toEqual([
      "run.started",
      "message.delta",
      "message.delta",
      "message.delta",
      "message.delta",
      "message.completed",
      "run.completed",
    ])
  })

  it("offers one model with reasoning efforts and one without", async () => {
    const driver = new FakeAgentDriver()
    expect(driver.features.modelCatalog).toBe(true)
    await expect(driver.listModels()).resolves.toBe(FAKE_MODELS)
    expect(FAKE_MODELS.map((model) => model.efforts?.length ?? 0)).toEqual([4, 0])
  })

  it("plays a scripted turn with a plan, tool calls and a summary", async () => {
    const driver = new FakeAgentDriver({ stepMs: 0 })
    const session = await driver.createSession({ threadId: "th_1", cwd: "/tmp" })
    const events: AgentEvent[] = []
    await driver.send(
      session,
      { text: FAKE_SCRIPT_TEXT },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        requestApproval: async () => "deny",
      },
    )
    const tools = events.flatMap((event) => (event.type === "tool.started" ? [event.name] : []))
    expect(tools).toEqual(["Read", "Read", "Grep", "Edit", "Bash", "Edit", "Bash"])
    const commands = events.flatMap((event) =>
      event.type === "tool.completed" && event.name === "Bash" ? [event] : [],
    )
    // 第一次 lint 失败（退出码 1），修好后再跑一次；两条命令的输出都按片段流出。
    expect(commands.map((event) => [event.isError, event.exitCode])).toEqual([
      [true, 1],
      [false, 0],
    ])
    const deltas = events.filter((event) => event.type === "tool.outputDelta")
    expect(deltas.map((event) => event.toolCallId)).toEqual([
      ...Array(3).fill("fake-lint-1"),
      ...Array(5).fill("fake-bash-1"),
    ])
    expect(events.filter((event) => event.type === "plan.updated")).toHaveLength(3)
    expect(events.filter((event) => event.type === "message.completed")).toHaveLength(3)
    expect(events.at(-1)).toEqual({ type: "run.completed" })
  })

  it("plays the showcase with thinking and every kind of tool", async () => {
    const driver = new FakeAgentDriver({ stepMs: 0 })
    const session = await driver.createSession({ threadId: "th_1", cwd: "/tmp" })
    const events: AgentEvent[] = []
    await driver.send(
      session,
      { text: FAKE_SHOWCASE_TEXT },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        requestApproval: async () => "deny",
      },
    )
    const tools = new Set(
      events.flatMap((event) => (event.type === "tool.started" ? [event.name] : [])),
    )
    for (const name of [
      "Read",
      "Glob",
      "Grep",
      "Bash",
      "TodoWrite",
      "ExitPlanMode",
      "Write",
      "Edit",
      "MultiEdit",
      "BashOutput",
      "KillShell",
      "WebSearch",
      "WebFetch",
      "Skill",
      "mcp__context7__get-library-docs",
    ]) {
      expect(tools.has(name), name).toBe(true)
    }
    expect(events.filter((event) => event.type === "reasoning.completed")).toHaveLength(2)
    expect(events.some((event) => event.type === "reasoning.delta")).toBe(true)
    expect(events.some((event) => event.type === "subagent.started")).toBe(true)
    expect(events.at(-1)).toEqual({ type: "run.completed" })
  })

  it("calls the sample plugins' tools under the names their renderers declare", async () => {
    const driver = new FakeAgentDriver({ stepMs: 0 })
    const session = await driver.createSession({ threadId: "th_1", cwd: "/tmp" })
    const events: AgentEvent[] = []
    await driver.send(
      session,
      { text: FAKE_TOOL_RENDERERS_TEXT },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        requestApproval: async () => "deny",
      },
    )
    expect(
      events.flatMap((event) => (event.type === "tool.completed" ? [event.name] : [])),
    ).toEqual(["mcp__pigcode__clock_now", "clock_now", "debug_probe"])
    expect(events.at(-1)).toEqual({ type: "run.completed" })
  })

  it("drives the built-in browser through MCP tools like an agent would", async () => {
    const calls: Array<{ threadId: string; name: string; input: unknown }> = []
    const snapshot = [
      "URL: http://127.0.0.1:4173/",
      "Interactive elements (pass ref to browser_click / browser_type):",
      '[e1] textbox "邮箱"',
      '[e2] textbox "密码" (password)',
      '[e3] button "登录"',
    ].join("\n")
    const driver = new FakeAgentDriver({
      stepMs: 0,
      callTool: async (threadId, name, input) => {
        calls.push({ threadId, name, input })
        if (name === "browser_snapshot") return { content: [{ type: "text", text: snapshot }] }
        if (name === "browser_screenshot") {
          return {
            content: [
              { type: "image", data: "AAAA", mimeType: "image/jpeg" },
              { type: "text", text: "Screenshot" },
            ],
          }
        }
        return { content: [{ type: "text", text: "ok" }] }
      },
    })
    const session = await driver.createSession({ threadId: "th_9", cwd: "/tmp" })
    const events: AgentEvent[] = []
    await driver.send(
      session,
      { text: `${FAKE_BROWSER_PREFIX}http://127.0.0.1:4173/` },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        requestApproval: async () => "deny",
      },
    )
    expect(calls.map((call) => [call.threadId, call.name])).toEqual([
      ["th_9", "browser_open"],
      ["th_9", "browser_snapshot"],
      ["th_9", "browser_type"],
      ["th_9", "browser_type"],
      ["th_9", "browser_click"],
      ["th_9", "browser_wait_for"],
      ["th_9", "browser_screenshot"],
    ])
    expect(calls[2]?.input).toEqual({ ref: "e1", text: "demo@pigcode.dev", clear: true })
    expect(calls[4]?.input).toEqual({ ref: "e3" })
    const started = events.flatMap((event) => (event.type === "tool.started" ? [event.name] : []))
    expect(started[0]).toBe("mcp__pigcode__browser_open")
    const shot = events.filter((event) => event.type === "tool.completed").at(-1)
    expect(shot).toMatchObject({
      name: "mcp__pigcode__browser_screenshot",
      output: [
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
        { type: "text", text: "Screenshot" },
      ],
    })
    expect(events.at(-1)).toEqual({ type: "run.completed" })
  })

  it("reports a browser failure instead of hanging", async () => {
    const driver = new FakeAgentDriver({
      stepMs: 0,
      callTool: async () => {
        throw new Error("The built-in browser is only available in the Pigcode desktop app.")
      },
    })
    const session = await driver.createSession({ threadId: "th_9", cwd: "/tmp" })
    const events: AgentEvent[] = []
    await driver.send(
      session,
      { text: `${FAKE_BROWSER_PREFIX}localhost:3000` },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        requestApproval: async () => "deny",
      },
    )
    expect(events.find((event) => event.type === "tool.completed")).toMatchObject({
      isError: true,
    })
    const messages = events.flatMap((event) =>
      event.type === "message.completed" ? [event.text] : [],
    )
    expect(messages.at(-1)).toContain("浏览器操作失败")
    expect(events.at(-1)).toEqual({ type: "run.completed" })
  })

  it("spawns two sub-agents whose work is tagged with their task", async () => {
    const driver = new FakeAgentDriver({ stepMs: 0 })
    const session = await driver.createSession({ threadId: "th_1", cwd: "/tmp" })
    const events: AgentEvent[] = []
    await driver.send(
      session,
      { text: FAKE_SUBAGENT_TEXT },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        requestApproval: async () => "deny",
      },
    )
    const started = events.flatMap((event) =>
      event.type === "subagent.started" ? [event.toolCallId] : [],
    )
    expect(started).toEqual(["fake-task-explore", "fake-task-review"])
    const completed = events.flatMap((event) =>
      event.type === "subagent.completed" ? [event.toolCallId] : [],
    )
    expect(completed).toEqual(["fake-task-explore", "fake-task-review"])
    const childTools = events.flatMap((event) =>
      event.type === "tool.started" ? [event.parentToolUseId] : [],
    )
    expect(new Set(childTools)).toEqual(new Set(["fake-task-explore", "fake-task-review"]))
    expect(events.at(-1)).toEqual({ type: "run.completed" })
  })
})
