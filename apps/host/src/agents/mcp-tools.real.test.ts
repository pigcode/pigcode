/**
 * 真实 Agent 的 MCP：Claude Code 和 Codex 都要能列出并调用插件工具。
 * 默认跳过；跑法：PIGCODE_REAL_CLAUDE=1 pnpm exec vitest run apps/host/src/agents/mcp-tools.real.test.ts
 * （Codex 用 PIGCODE_REAL_CODEX=1，也可以两个一起设）。
 *
 * 已知问题（2026-11-05）：Codex 这一半现在会失败。真实 app-server 没有启动我们在 thread/start 里给的
 * config.mcp_servers：插件工具的 stdio 桥一次 hello 都没有。模型是凭环境自己给出时间的，不是调用工具。
 * 需要查这一版 app-server 的配置覆盖方式。Claude 这一半在本机也还没跑通，CLI 指向的代理不认这些模型 id。
 */
import { randomUUID } from "node:crypto"
import type { AgentEvent } from "@pigcode/contracts"
import { ClaudeDriver } from "@pigcode/agent-claude/driver"
import { CodexDriver } from "@pigcode/agent-codex/driver"
import type { AgentDriver, SessionMcp } from "@pigcode/plugin-sdk"
import { Context } from "cordis"
import { expect, it } from "vitest"
import { apply as mcpBridge } from "../services/mcp-bridge"

/**
 * 插件工具：返回一个随机口令。口令只能用工具拿到，模型从别处编不出来，回答里出现它就证明工具真的被调用了。
 * 用时间不行：模型可能从运行环境里知道当前时间，不调工具也能答对（Codex 会这样）。
 */
const SECRET_TOOL = {
  name: "secret_value",
  description: "Return the secret value for this session",
  inputSchema: { type: "object", properties: {} },
}

const claudeEnabled = process.env.PIGCODE_REAL_CLAUDE === "1"
const codexEnabled = process.env.PIGCODE_REAL_CODEX === "1"

/** 带一个插件工具的真实桥；每次调用都起一个新的 socket 服务。工具被调用时记下时间。 */
async function clockBridge(): Promise<{
  ctx: Context
  mcpFor: (threadId: string) => SessionMcp
  secret: string
  called: () => string | undefined
}> {
  const ctx = new Context()
  await ctx.plugin(mcpBridge)
  const secret = randomUUID()
  let calledAt: string | undefined
  ctx.mcp.registerTool("plugin.secret", SECRET_TOOL, async () => {
    calledAt = new Date().toISOString()
    return { value: secret }
  })
  return {
    ctx,
    secret,
    called: () => calledAt,
    mcpFor: (threadId) => {
      const mcp = ctx.mcpBridge.sessionMcp(threadId)
      if (!mcp) throw new Error("no mcp tools")
      return mcp
    },
  }
}

/** 让 Agent 调用这个工具，返回这一轮的事件和工具被调用的时间。 */
async function callClock(
  driver: AgentDriver,
  model: string | undefined,
): Promise<{ events: AgentEvent[]; calledAt: string | undefined; secret: string }> {
  const { ctx, mcpFor, secret, called } = await clockBridge()
  const threadId = "real-mcp"
  const events: AgentEvent[] = []
  const session = await driver.createSession({
    threadId,
    cwd: process.cwd(),
    permissionMode: "workspace-write",
    ...(model ? { model } : {}),
    mcp: mcpFor(threadId),
  })
  try {
    await driver.send(
      session,
      {
        text: "Call the secret_value tool and reply with exactly the value it returns. You cannot know it otherwise.",
      },
      {
        signal: new AbortController().signal,
        emit: (event) => events.push(event),
        requestApproval: async () => "allow-once",
      },
    )
  } finally {
    await driver.dispose(session)
    await ctx.fiber.dispose()
  }
  return { events, calledAt: called(), secret }
}

/**
 * 两种 Agent 的断言相同：工具被调用，回答里带上了只有工具才有的口令。
 * 这一版 Codex app-server 不为 MCP 工具调用发 item 通知，所以不按 tool.started 断言。
 */
function expectToolWasCalled(
  events: AgentEvent[],
  calledAt: string | undefined,
  secret: string,
): void {
  const failure = events.find((event) => event.type === "run.failed")
  expect(failure, failure?.type === "run.failed" ? failure.message : "").toBeUndefined()
  expect(calledAt).toBeDefined()
  const answer = events
    .flatMap((event) => (event.type === "message.completed" ? [event.text ?? ""] : []))
    .join("\n")
  expect(answer).toContain(secret)
  expect(events.some((event) => event.type === "run.completed")).toBe(true)
}

it.skipIf(!claudeEnabled)(
  "lists and calls plugin MCP tools from the real Claude CLI",
  async () => {
    const { events, calledAt, secret } = await callClock(
      new ClaudeDriver(),
      process.env.PIGCODE_CLAUDE_MODEL,
    )
    expectToolWasCalled(events, calledAt, secret)
  },
  180_000,
)

it.skipIf(!codexEnabled)(
  "lists and calls plugin MCP tools from the real Codex app-server",
  async () => {
    const { events, calledAt, secret } = await callClock(
      new CodexDriver(),
      process.env.PIGCODE_CODEX_MODEL,
    )
    expectToolWasCalled(events, calledAt, secret)
  },
  180_000,
)
