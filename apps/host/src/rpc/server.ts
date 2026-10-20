/** 把 RPC 请求分发给 Host 服务，并把线程事件推送给订阅者。 */
import type { Context } from "cordis"
import type { HostTransport } from "@pigcode/client-runtime/transport"
import {
  commandSchemas,
  parseRpcRequest,
  rpcFailureSchema,
  rpcSuccessSchema,
} from "@pigcode/contracts"
import type { CommandMethod } from "@pigcode/contracts"

/** 基于 Cordis 服务处理 RPC 请求的 Host 侧服务器。 */
export class RpcServer {
  private disposers: Array<() => void> = []

  constructor(
    private readonly ctx: Context,
    private readonly transport: HostTransport,
  ) {}

  /** 开始监听传输层消息。 */
  start(): void {
    this.disposers.push(
      this.transport.onMessage((message) => {
        void this.handle(message)
      }),
    )
  }

  /** 停止监听并释放所有订阅。 */
  stop(): void {
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }

  private async handle(message: unknown): Promise<void> {
    let request
    try {
      request = parseRpcRequest(message)
    } catch {
      return
    }
    try {
      const result = await this.dispatch(request.method, request.params)
      this.transport.send(rpcSuccessSchema.parse({ jsonrpc: "2.0", id: request.id, result }))
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "unknown error"
      this.transport.send(
        rpcFailureSchema.parse({
          jsonrpc: "2.0",
          id: request.id,
          error: { code: "COMMAND_FAILED", message: messageText, retryable: false },
        }),
      )
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (!(method in commandSchemas)) throw new Error(`unknown method: ${method}`)
    const command = method as CommandMethod
    const parsed = commandSchemas[command].parse(params)

    switch (command) {
      case "project.list":
        return this.ctx.projects.list()
      case "project.add":
        return this.ctx.projects.add((parsed as { rootPath: string }).rootPath)
      case "thread.list":
        return this.ctx.threads.list((parsed as { projectId?: string }).projectId)
      case "thread.create": {
        const value = parsed as { projectId: string; title: string; providerId: string }
        const thread = this.ctx.threads.create(value.projectId, value.title, value.providerId)
        this.ctx.sessions.append({
          threadId: thread.id,
          runId: null,
          type: "thread.created",
          payload: { title: thread.title },
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
        })
        return thread
      }
      case "thread.subscribe": {
        const value = parsed as { threadId: string; cursor: number }
        const events = this.ctx.sessions.read(value.threadId, value.cursor)
        const unsubscribe = this.ctx.sessions.subscribe(value.threadId, (event) => {
          this.transport.send({ jsonrpc: "2.0", method: "thread.event", params: event })
        })
        this.disposers.push(unsubscribe)
        return {
          snapshot: {
            thread: this.ctx.threads.get(value.threadId) ?? null,
            runs: [],
            items: [],
            pendingRequests: this.ctx.providers.listPendingRequests(value.threadId),
          },
          cursor: events.at(-1)?.seq ?? value.cursor,
          events,
        }
      }
      case "run.start": {
        const value = parsed as { threadId: string; text: string }
        const { runId } = await this.ctx.providers.startRun(value.threadId, value.text, (event) => {
          this.transport.send({
            jsonrpc: "2.0",
            method: "thread.delta",
            params: { threadId: value.threadId, event },
          })
        })
        return { runId }
      }
      case "run.interrupt": {
        const value = parsed as { runId: string }
        return { interrupted: this.ctx.providers.cancelRun(value.runId) }
      }
      case "run.respondApproval": {
        const value = parsed as {
          threadId: string
          runId: string
          requestId: string
          decision: "allow-once" | "allow-for-session" | "deny"
        }
        this.ctx.providers.respondApproval(
          value.threadId,
          value.runId,
          value.requestId,
          value.decision,
        )
        return { ok: true }
      }
      case "provider.detect":
        return this.ctx.providers.detect()
      case "provider.list":
        return this.ctx.providers.list()
      case "plugin.list":
        return this.ctx.plugins.list()
      case "plugin.installLocal":
        return this.ctx.plugins.installLocal((parsed as { sourceDir: string }).sourceDir)
      case "plugin.enable":
        return this.ctx.plugins.enable((parsed as { id: string }).id)
      case "plugin.disable":
        return this.ctx.plugins.disable((parsed as { id: string }).id)
      case "plugin.bootGraph":
        return this.ctx.plugins.bootGraph()
      default:
        throw new Error(`unsupported method: ${method}`)
    }
  }
}
