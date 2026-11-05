/**
 * 插件工具的 MCP 桥起不来时，driver 要产出一条会话提示（#57）。
 * 这条通知在 thread/start 之后立刻就到，那时还没有 run，所以先攒着，下一次 send 时补发；
 * 用户自己配置的别的 MCP server 不归 Pigcode 管，不提示。
 */
import type { AgentEvent } from "@pigcode/contracts"
import type { AgentRuntime } from "@pigcode/plugin-sdk"
import { describe, expect, it } from "vitest"
import { CodexDriver } from "./driver"
import { ScriptedTransport } from "./scripted-transport"

/** 跑一轮，收集事件；startup 在 thread/start 之后、turn/start 之前推入。 */
async function runWithStartup(startup: readonly Record<string, unknown>[]): Promise<AgentEvent[]> {
  const transport = new ScriptedTransport({
    nativeThreadId: "th_native",
    onTurnStart: (message) => {
      transport.push({ id: message.id, result: { turn: { id: "turn_1" } } })
      setTimeout(() => {
        transport.push({
          method: "turn/completed",
          params: { threadId: "th_native", turn: { id: "turn_1", status: "completed" } },
        })
      }, 0)
    },
  })
  const driver = new CodexDriver({ transportFactory: () => transport })
  const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
  // 这条通知的真实时序：thread/start 的应答之后马上到，第一个 turn 之前。
  for (const params of startup)
    transport.push({ method: "mcpServer/startupStatus/updated", params })
  const events: AgentEvent[] = []
  const runtime: AgentRuntime = {
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    requestApproval: async () => "allow-once",
  }
  await driver.send(session, { text: "run" }, runtime)
  return events
}

describe("CodexDriver MCP startup notices", () => {
  it("reports the plugin bridge failing as a notice on the next turn", async () => {
    const events = await runWithStartup([
      { threadId: "th_native", name: "pigcode", status: "starting" },
      { threadId: "th_native", name: "pigcode", status: "failed", error: "spawn ENOENT" },
    ])
    expect(events.filter((event) => event.type === "notice")).toEqual([
      { type: "notice", level: "warning", key: "mcp.bridge.failed", params: { name: "pigcode" } },
    ])
  })

  it("ignores other servers and healthy startups", async () => {
    const events = await runWithStartup([
      { threadId: "th_native", name: "open-design", status: "failed", error: "boom" },
      { threadId: "th_native", name: "pigcode", status: "starting" },
      { threadId: "th_native", name: "pigcode", status: "ready" },
    ])
    expect(events.some((event) => event.type === "notice")).toBe(false)
  })

  it("says it once even when the server is retried", async () => {
    const events = await runWithStartup([
      { threadId: "th_native", name: "pigcode", status: "failed", error: "boom" },
      { threadId: "th_native", name: "pigcode", status: "failed", error: "boom" },
    ])
    expect(events.filter((event) => event.type === "notice")).toHaveLength(1)
  })

  it("does not repeat the same problem on the next turn", async () => {
    const transport = new ScriptedTransport({
      nativeThreadId: "th_native",
      onTurnStart: (message) => {
        transport.push({ id: message.id, result: { turn: { id: "turn_1" } } })
        setTimeout(() => {
          transport.push({
            method: "turn/completed",
            params: { threadId: "th_native", turn: { id: "turn_1", status: "completed" } },
          })
        }, 0)
      },
    })
    const driver = new CodexDriver({ transportFactory: () => transport })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    // 真实 app-server 每轮都会重发启动结果；用户已经看过一次就别再刷。
    const events: AgentEvent[] = []
    const runtime: AgentRuntime = {
      signal: new AbortController().signal,
      emit: (event) => events.push(event),
      requestApproval: async () => "allow-once",
    }
    for (const text of ["first", "second"]) {
      transport.push({
        method: "mcpServer/startupStatus/updated",
        params: { threadId: "th_native", name: "pigcode", status: "failed" },
      })
      await driver.send(session, { text }, runtime)
    }
    expect(events.filter((event) => event.type === "notice")).toHaveLength(1)
  })

  it("forwards a failure that arrives during the turn", async () => {
    const transport = new ScriptedTransport({
      nativeThreadId: "th_native",
      onTurnStart: (message) => {
        transport.push({ id: message.id, result: { turn: { id: "turn_1" } } })
        // 本轮已经开始了：不用等下一轮，直接推送。
        transport.push({
          method: "mcpServer/startupStatus/updated",
          params: { threadId: "th_native", name: "pigcode", status: "failed" },
        })
        setTimeout(() => {
          transport.push({
            method: "turn/completed",
            params: { threadId: "th_native", turn: { id: "turn_1", status: "completed" } },
          })
        }, 0)
      },
    })
    const driver = new CodexDriver({ transportFactory: () => transport })
    const session = await driver.createSession({ threadId: "t1", cwd: "/tmp" })
    const events: AgentEvent[] = []
    await driver.send(
      session,
      { text: "run" },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        requestApproval: async () => "allow-once",
      },
    )
    expect(events.some((event) => event.type === "notice")).toBe(true)
  })
})
