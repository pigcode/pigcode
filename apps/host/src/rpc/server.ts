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
  /** 每个线程只保留一个实时监听器；重复订阅先释放旧的。 */
  private readonly subscriptions = new Map<string, () => void>()

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
    for (const unsubscribe of this.subscriptions.values()) unsubscribe()
    this.subscriptions.clear()
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
      case "thread.rename": {
        const value = parsed as { threadId: string; title: string }
        const thread = this.ctx.threads.rename(value.threadId, value.title)
        if (!thread) throw new Error(`thread not found: ${value.threadId}`)
        this.ctx.sessions.append({
          threadId: thread.id,
          runId: null,
          type: "thread.updated",
          payload: { title: thread.title },
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
        })
        return thread
      }
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
        this.subscriptions.get(value.threadId)?.()
        const unsubscribe = this.ctx.sessions.subscribe(value.threadId, (event) => {
          this.transport.send({ jsonrpc: "2.0", method: "thread.event", params: event })
        })
        this.subscriptions.set(value.threadId, unsubscribe)
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
      case "thread.unsubscribe": {
        const value = parsed as { threadId: string }
        this.subscriptions.get(value.threadId)?.()
        this.subscriptions.delete(value.threadId)
        return { ok: true }
      }
      case "thread.switchProvider": {
        const value = parsed as { threadId: string; providerId: string; modelId?: string | null }
        return this.ctx.providers.switchProvider(
          value.threadId,
          value.providerId,
          value.modelId ?? null,
        )
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
      case "run.list":
        return { runs: this.ctx.providers.listRuns() }
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
      case "provider.default":
        return { id: await this.ctx.providers.defaultProvider() }
      case "provider.models":
        return this.ctx.providers.models((parsed as { providerId: string }).providerId)
      case "plugin.list":
        return this.ctx.plugins.list()
      case "plugin.install":
        return this.ctx.plugins.install((parsed as { spec: string }).spec)
      case "plugin.installLocal":
        return this.ctx.plugins.installLocal((parsed as { sourceDir: string }).sourceDir)
      case "plugin.enable":
        return this.ctx.plugins.enable((parsed as { id: string }).id)
      case "plugin.disable":
        return this.ctx.plugins.disable((parsed as { id: string }).id)
      case "plugin.bootGraph":
        return this.ctx.plugins.bootGraph()
      case "workspace.tree":
        return this.ctx.workspace.tree((parsed as { threadId: string }).threadId)
      case "workspace.readFile": {
        const value = parsed as { threadId: string; path: string }
        return this.ctx.workspace.readFile(value.threadId, value.path)
      }
      case "workspace.search": {
        const value = parsed as { threadId: string; query: string; glob?: string }
        return this.ctx.workspace.search(value.threadId, value.query, value.glob)
      }
      case "git.status":
        return this.ctx.git.status((parsed as { threadId: string }).threadId)
      case "git.diff": {
        const value = parsed as { threadId: string; base: string; head: string }
        return this.ctx.git.diff(value.threadId, value.base, value.head)
      }
      case "pr.status":
        return this.ctx.github.status((parsed as { threadId: string }).threadId)
      case "pr.create": {
        const value = parsed as {
          threadId: string
          title: string
          body?: string
          base?: string
        }
        return this.ctx.github.create(value.threadId, {
          title: value.title,
          ...(value.body === undefined ? {} : { body: value.body }),
          ...(value.base === undefined ? {} : { base: value.base }),
        })
      }
      case "schedule.list":
        return this.ctx.schedules.list()
      case "schedule.create": {
        const value = parsed as {
          threadId: string
          prompt: string
          intervalSeconds: number
          enabled: boolean
        }
        return this.ctx.schedules.create(value)
      }
      case "schedule.update": {
        const value = parsed as {
          id: string
          prompt?: string
          intervalSeconds?: number
          enabled?: boolean
        }
        return this.ctx.schedules.update(value.id, value)
      }
      case "schedule.delete": {
        const value = parsed as { id: string }
        return { deleted: this.ctx.schedules.delete(value.id) }
      }
      case "schedule.runNow":
        return this.ctx.schedules.runNow((parsed as { id: string }).id)
      case "checkpoint.list":
        return this.ctx.checkpoints.list((parsed as { threadId: string }).threadId)
      case "checkpoint.create": {
        const value = parsed as { threadId: string; label?: string }
        return this.ctx.checkpoints.create(value.threadId, value.label)
      }
      case "checkpoint.restore": {
        const value = parsed as { threadId: string; checkpointId: string }
        return this.ctx.checkpoints.restore(value.threadId, value.checkpointId)
      }
      case "worktree.create":
        return this.ctx.worktrees.create((parsed as { threadId: string }).threadId)
      case "worktree.switch": {
        const value = parsed as { threadId: string; path: string }
        return this.ctx.worktrees.switch(value.threadId, value.path)
      }
      case "worktree.remove":
        return this.ctx.worktrees.remove((parsed as { threadId: string }).threadId)
      case "terminal.open": {
        const value = parsed as { threadId: string; cols: number; rows: number }
        const terminal = await this.ctx.terminal.open(value.threadId, value.cols, value.rows)
        this.disposers.push(
          this.ctx.terminal.subscribe(terminal.id, (data) => {
            this.transport.send({
              jsonrpc: "2.0",
              method: "terminal.output",
              params: { terminalId: terminal.id, data },
            })
          }),
        )
        return terminal
      }
      case "terminal.write": {
        const value = parsed as { terminalId: string; data: string }
        return this.ctx.terminal.write(value.terminalId, value.data)
      }
      case "terminal.resize": {
        const value = parsed as { terminalId: string; cols: number; rows: number }
        return this.ctx.terminal.resize(value.terminalId, value.cols, value.rows)
      }
      case "terminal.close":
        return this.ctx.terminal.close((parsed as { terminalId: string }).terminalId)
      default:
        throw new Error(`unsupported method: ${method}`)
    }
  }
}
