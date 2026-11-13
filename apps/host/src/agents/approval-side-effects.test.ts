/**
 * 拒绝或取消审批后，工具不能真的执行。用遵守权限协议的替身代替 CLI：只有收到「允许」才写文件，
 * 其余都是真实代码，从 RPC 决议经 Host、driver 一直走到 Agent 协议。真实 CLI 由 PIGCODE_REAL_* 手动验证。
 */
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CanUseTool, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeDriver, type ClaudeQueryFn } from "@pigcode/agent-claude/driver"
import { CodexDriver } from "@pigcode/agent-codex/driver"
import { ReplayCodexTransport } from "@pigcode/agent-codex/transport"
import type { AgentDriver } from "@pigcode/plugin-sdk"
import { Context } from "cordis"
import { afterEach, describe, expect, it, vi } from "vitest"
import { MemoryTransport } from "../rpc/memory-transport"
import { RpcServer } from "../rpc/server"
import { apply as projects } from "../services/projects"
import { apply as sessions } from "../services/sessions"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { apply as agentsPlugin } from "./registry"

/** 工具要做的事：写一个文件。 */
type RunTool = () => Promise<void>

/** 替身 Claude Code：先问 canUseTool，只有允许才运行工具；和 SDK 一样，拒绝后这一轮照常结束。 */
function claudeStandIn(runTool: RunTool): AgentDriver {
  const queryFn: ClaudeQueryFn = ({ options }) => {
    async function* generate(): AsyncGenerator<SDKMessage> {
      yield { type: "system", subtype: "init", session_id: "native" } as unknown as SDKMessage
      const canUseTool = options?.canUseTool as CanUseTool
      const permission = await canUseTool("Bash", { command: "write the file" }, {
        signal: new AbortController().signal,
        toolUseID: "tool_1",
      } as Parameters<CanUseTool>[2])
      if (permission?.behavior === "allow") await runTool()
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "native",
        modelUsage: {},
        total_cost_usd: 0,
      } as unknown as SDKMessage
    }
    return Object.assign(generate(), { interrupt: async () => undefined }) as unknown as Query
  }
  return new ClaudeDriver({ queryFn })
}

/** 替身 app-server：发出命令审批请求，只有收到 accept 才运行命令；被拒绝或中断时结束这一轮。 */
class CodexStandIn extends ReplayCodexTransport {
  constructor(private readonly runTool: RunTool) {
    super([])
  }

  override send(line: string): void {
    super.send(line)
    const message = JSON.parse(line) as {
      id?: string | number
      method?: string
      result?: { decision?: string }
    }
    if (message.method === "initialize") this.push({ id: message.id, result: {} })
    if (message.method === "thread/start") {
      this.push({ id: message.id, result: { thread: { id: "native" } } })
    }
    if (message.method === "turn/start") {
      this.push({ id: message.id, result: { turn: { id: "turn_1" } } })
      this.push({
        id: "approval_1",
        method: "item/commandExecution/requestApproval",
        params: { itemId: "item_1", command: "write the file" },
      })
    }
    if (message.method === "turn/interrupt") {
      this.push({ id: message.id, result: {} })
      this.finishTurn("interrupted")
    }
    if (message.id === "approval_1") {
      void this.answered(message.result?.decision)
    }
  }

  private async answered(decision: string | undefined): Promise<void> {
    if (decision === "accept") await this.runTool()
    this.finishTurn("completed")
  }

  private finishTurn(status: string): void {
    this.push({
      method: "turn/completed",
      params: { threadId: "native", turn: { id: "turn_1", status } },
    })
  }
}

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe.each([
  { agent: "claude", driver: claudeStandIn },
  {
    agent: "codex",
    driver: (runTool: RunTool): AgentDriver =>
      new CodexDriver({ transportFactory: () => new CodexStandIn(runTool) }),
  },
])("approving a $agent tool call", ({ agent, driver }) => {
  /** 启动一个 run，等它停在审批上。 */
  async function runUntilApproval() {
    const root = await mkdtemp(join(tmpdir(), "pigcode-approval-"))
    const file = join(root, "written-by-tool.txt")
    const ctx = new Context()
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)
    await ctx.plugin(agentsPlugin)
    ctx.agents.register(driver(() => writeFile(file, "side effect")))
    const transport = new MemoryTransport()
    const server = new RpcServer(ctx, transport.host)
    server.start()
    cleanups.push(async () => {
      server.stop()
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    const project = ctx.projects.add(root)
    const thread = ctx.threads.create(project.id, "Approval", agent, undefined, {
      permissionMode: "approval-required",
    })
    const run = await ctx.agents.startRun(thread.id, "write the file")
    const requestId = await vi.waitFor(() => {
      const [pending] = ctx.agents.listPendingRequests(thread.id)
      if (!pending) throw new Error("not waiting for approval yet")
      return pending.id
    })
    expect(ctx.agents.getRunStatus(run.runId)).toBe("waiting-approval")
    expect(existsSync(file)).toBe(false)

    /** 走 RPC，和界面点按钮一样。 */
    const callRpc = async (method: string, params: unknown) => {
      const id = `call-${method}`
      transport.client.send({ jsonrpc: "2.0", id, method, params })
      for (;;) {
        const message = (await transport.client.next()) as {
          id?: string
          result?: unknown
          error?: { message: string }
        }
        if (message.id === id) return message
      }
    }
    const respond = (decision: string) =>
      callRpc("run.respondApproval", {
        threadId: thread.id,
        runId: run.runId,
        requestId,
        decision,
      })
    return { ctx, thread, run, file, respond, callRpc }
  }

  /** 替身写文件是异步的，给它足够的时间，免得「没写」只是因为还没来得及。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

  it("runs the tool once allowed, which shows the checks below can fail", async () => {
    const { ctx, run, file, respond } = await runUntilApproval()
    expect((await respond("allow-once")).error).toBeUndefined()
    await run.done
    await vi.waitFor(() => expect(existsSync(file)).toBe(true))
    expect(ctx.agents.getRunStatus(run.runId)).toBe("completed")
  })

  it("does not run the tool once denied, and the run still finishes", async () => {
    const { ctx, thread, run, file, respond } = await runUntilApproval()
    expect((await respond("deny")).error).toBeUndefined()
    await run.done
    await settle()
    expect(existsSync(file)).toBe(false)
    expect(ctx.agents.getRunStatus(run.runId)).toBe("completed")
    expect(ctx.agents.listPendingRequests(thread.id)).toEqual([])
  })

  it("does not run the tool when the run is cancelled while waiting", async () => {
    const { ctx, thread, run, file, respond, callRpc } = await runUntilApproval()
    const cancelled = await callRpc("run.interrupt", { threadId: thread.id, runId: run.runId })
    expect(cancelled.result).toEqual({ interrupted: true })
    await run.done
    await settle()
    expect(existsSync(file)).toBe(false)
    expect(ctx.agents.getRunStatus(run.runId)).toBe("interrupted")
    expect(ctx.agents.listPendingRequests(thread.id)).toEqual([])

    // 用户在取消的同时点了「允许」：决议到得太晚，不能再让工具跑起来。
    const late = await respond("allow-once")
    expect(late.error?.message).toContain("approval not pending")
    await settle()
    expect(existsSync(file)).toBe(false)
  })
})
