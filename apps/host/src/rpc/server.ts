/** 把 RPC 请求分发给 Host 服务，并把线程事件推送给订阅者。 */
import type { Context } from "cordis"
import type { HostTransport } from "@pigcode/client-runtime/transport"
import {
  commandSchemas,
  isHostErrorCode,
  parseRpcRequest,
  rpcFailureSchema,
  rpcSuccessSchema,
} from "@pigcode/contracts"
import type {
  CommandMethod,
  CommandParams,
  PermissionMode,
  ReasoningEffort,
} from "@pigcode/contracts"
import { buildSubagentBrief } from "../agents/switching"
import { uninstallPluginAndClearDefault } from "./agents"
import { dispatchAgentCommand } from "./agent-commands"

/** 界面有专门说明的错误（gh 未安装、未登录、没有远程仓库）带上自己的错误码，其余是 COMMAND_FAILED。 */
function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null
  return isHostErrorCode(code) ? code : "COMMAND_FAILED"
}

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
          error: { code: errorCode(error), message: messageText, retryable: false },
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
      case "project.add": {
        const value = parsed as { rootPath: string; name?: string }
        return this.ctx.projects.add(value.rootPath, value.name)
      }
      case "project.rename": {
        const value = parsed as { projectId: string; name: string }
        const project = this.ctx.projects.rename(value.projectId, value.name)
        if (!project) throw new Error(`project not found: ${value.projectId}`)
        return project
      }
      case "project.remove": {
        const value = parsed as { projectId: string }
        const project = this.ctx.projects.remove(value.projectId)
        if (!project) throw new Error(`project not found: ${value.projectId}`)
        // 项目的会话随项目一起从侧栏消失，还在跑的 run 同样先停下。
        for (const run of this.ctx.agents.listRuns()) {
          if (this.ctx.threads.get(run.threadId)?.projectId === value.projectId) {
            this.ctx.agents.cancelRun(run.runId)
          }
        }
        // 终端也一样：之后没有界面能关它，里面的进程会一直跑下去。
        for (const thread of this.ctx.threads.list(value.projectId)) {
          this.ctx.get("terminal")?.closeThread(thread.id)
        }
        return project
      }
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
      case "thread.archive": {
        const value = parsed as { threadId: string }
        // 归档的会话从界面上消失；还在跑或排队的 run 先停下，免得在看不见的地方改代码或卡在审批上。
        // 子代理随主会话一起归档，它们的 run 也一并停下。
        const archived = new Set([
          value.threadId,
          ...this.ctx.threads.children(value.threadId).map((child) => child.id),
        ])
        for (const run of this.ctx.agents.listRuns()) {
          if (archived.has(run.threadId)) this.ctx.agents.cancelRun(run.runId)
        }
        // 终端也一样：归档后没有界面能关它，里面的进程会一直跑下去。
        for (const threadId of archived) this.ctx.get("terminal")?.closeThread(threadId)
        const thread = this.ctx.threads.archive(value.threadId)
        if (!thread) throw new Error(`thread not found: ${value.threadId}`)
        return thread
      }
      case "thread.create": {
        const value = parsed as {
          projectId: string
          title: string
          agentId: string
          instanceId?: string
          parentThreadId?: string
          modelId?: string
          permissionMode?: PermissionMode
        }
        const thread = this.ctx.threads.create(
          value.projectId,
          value.title,
          value.agentId,
          value.parentThreadId,
          {
            instanceId: value.instanceId,
            modelId: value.modelId,
            permissionMode: value.permissionMode,
          },
        )
        const now = new Date().toISOString()
        this.ctx.sessions.append({
          threadId: thread.id,
          runId: null,
          type: "thread.created",
          payload: {
            title: thread.title,
            ...(value.parentThreadId ? { parentThreadId: value.parentThreadId } : {}),
          },
          schemaVersion: 1,
          createdAt: now,
        })
        // 子代理的第一条消息前带上主会话的近况；只注入一次，之后按子代理自己的会话继续。
        const brief = value.parentThreadId
          ? buildSubagentBrief(this.ctx, value.parentThreadId)
          : null
        if (brief) {
          this.ctx.sessions.append({
            threadId: thread.id,
            runId: null,
            type: "thread.updated",
            payload: { handoff: brief },
            schemaVersion: 1,
            createdAt: now,
          })
        }
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
            pendingRequests: this.ctx.agents.listPendingRequests(value.threadId),
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
      case "thread.switchAgent": {
        const value = parsed as {
          threadId: string
          agentId: string
          instanceId?: string | null
          modelId?: string | null
        }
        return this.ctx.agents.switchAgent(
          value.threadId,
          value.agentId,
          value.modelId ?? null,
          value.instanceId ?? null,
        )
      }
      case "thread.setPermissionMode": {
        const value = parsed as { threadId: string; permissionMode: PermissionMode }
        const thread = this.ctx.threads.setPermissionMode(value.threadId, value.permissionMode)
        if (!thread) throw new Error(`thread not found: ${value.threadId}`)
        this.ctx.sessions.append({
          threadId: thread.id,
          runId: null,
          type: "thread.updated",
          payload: { permissionMode: thread.permissionMode },
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
        })
        return thread
      }
      case "run.start": {
        const value = parsed as {
          threadId: string
          text: string
          effort?: ReasoningEffort
          fast?: boolean
          ultracode?: boolean
          instanceId?: string
        }
        const { runId } = await this.ctx.agents.startRun(
          value.threadId,
          value.text,
          (event) => {
            this.transport.send({
              jsonrpc: "2.0",
              method: "thread.delta",
              params: { threadId: value.threadId, event },
            })
          },
          {
            ...(value.effort ? { effort: value.effort } : {}),
            ...(value.fast ? { fast: true } : {}),
            ...(value.ultracode ? { ultracode: true } : {}),
            ...(value.instanceId ? { instanceId: value.instanceId } : {}),
          },
        )
        return { runId }
      }
      case "run.list":
        return { runs: this.ctx.agents.listRuns() }
      case "run.interrupt": {
        const value = parsed as { runId: string }
        return { interrupted: this.ctx.agents.cancelRun(value.runId) }
      }
      case "run.respondApproval": {
        const value = parsed as {
          threadId: string
          runId: string
          requestId: string
          decision: "allow-once" | "allow-for-session" | "deny"
        }
        this.ctx.agents.respondApproval(
          value.threadId,
          value.runId,
          value.requestId,
          value.decision,
        )
        return { ok: true }
      }
      case "run.answerQuestion": {
        const value = parsed as {
          threadId: string
          runId: string
          requestId: string
          answers: string[]
        }
        this.ctx.agents.answerQuestion(value.threadId, value.runId, value.requestId, value.answers)
        return { ok: true }
      }
      case "agent.detect":
      case "agent.registered":
      case "agent.default":
      case "agent.models":
      case "agent.list":
      case "agent.updateSettings":
      case "agent.createInstance":
      case "agent.updateInstance":
      case "agent.removeInstance":
      case "agent.setDefault":
        return dispatchAgentCommand(this.ctx, command, parsed)
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
      case "plugin.uninstall":
        return uninstallPluginAndClearDefault(this.ctx, (parsed as { id: string }).id)
      case "plugin.installFromMarketplace": {
        const { marketplace, name } = parsed as CommandParams<"plugin.installFromMarketplace">
        return this.ctx.plugins.installFromMarketplace(marketplace, name)
      }
      case "plugin.update":
        return this.ctx.plugins.update((parsed as { id: string }).id)
      case "plugin.reload":
        return this.ctx.plugins.reload()
      case "marketplace.list":
        return this.ctx.plugins.marketplaces()
      case "marketplace.add":
        return this.ctx.plugins.addMarketplace((parsed as { source: string }).source)
      case "marketplace.refresh":
        return this.ctx.plugins.refreshMarketplaces((parsed as { id?: string }).id)
      case "marketplace.setEnabled": {
        const value = parsed as { id: string; enabled: boolean }
        return this.ctx.plugins.setMarketplaceEnabled(value.id, value.enabled)
      }
      case "marketplace.remove":
        return this.ctx.plugins.removeMarketplace((parsed as { id: string }).id)
      case "plugin.bootGraph":
        return this.ctx.plugins.bootGraph()
      case "workspace.tree":
        return this.ctx.workspace.tree((parsed as { threadId: string }).threadId)
      case "project.files":
        return this.ctx.workspace.projectTree((parsed as { projectId: string }).projectId)
      case "workspace.root":
        return { root: this.ctx.workspace.root((parsed as { threadId: string }).threadId) }
      case "workspace.list": {
        const value = parsed as { threadId: string; path: string }
        return this.ctx.workspace.list(value.threadId, value.path)
      }
      case "workspace.searchPaths": {
        const value = parsed as { threadId: string; query: string; limit?: number }
        return this.ctx.workspace.searchPaths(value.threadId, value.query, value.limit)
      }
      case "workspace.readFile": {
        const value = parsed as { threadId: string; path: string; encoding?: "text" | "image" }
        return this.ctx.workspace.readFile(value.threadId, value.path, value.encoding)
      }
      case "workspace.writeFile": {
        const value = parsed as {
          threadId: string
          path: string
          text: string
          expectedMtimeMs?: number
          eol?: "lf" | "crlf"
        }
        return this.ctx.workspace.writeFile(value.threadId, value.path, value.text, {
          expectedMtimeMs: value.expectedMtimeMs,
          eol: value.eol,
        })
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
      case "schedule.create":
        return this.ctx.schedules.create(parsed as CommandParams<"schedule.create">)
      case "schedule.update": {
        const { id, title, prompt, rule, endsAt, enabled } =
          parsed as CommandParams<"schedule.update">
        return this.ctx.schedules.update(id, {
          ...(title === undefined ? {} : { title }),
          ...(prompt === undefined ? {} : { prompt }),
          ...(rule === undefined ? {} : { rule }),
          ...(endsAt === undefined ? {} : { endsAt }),
          ...(enabled === undefined ? {} : { enabled }),
        })
      }
      case "schedule.runs": {
        const { id, limit, offset } = parsed as CommandParams<"schedule.runs">
        return this.ctx.schedules.runs(id, limit, offset)
      }
      case "schedule.deleteRun":
        return { deleted: this.ctx.schedules.deleteRun((parsed as { id: string }).id) }
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
      case "worktree.list":
        return this.ctx.worktrees.list((parsed as { threadId: string }).threadId)
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
