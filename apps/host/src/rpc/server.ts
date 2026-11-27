/** 把 RPC 请求分发给 Host 服务，并把线程事件推送给订阅者。 */
import { updateThreadModes } from "../agents/execution-modes"
import type { Context } from "cordis"
import type { HostTransport } from "@pigcode/client-runtime/transport"
import {
  commandSchemas,
  isHostErrorCode,
  parseRpcRequest,
  rpcFailureSchema,
  rpcSuccessSchema,
} from "@pigcode/contracts"
import type { CommandMethod, CommandParams, PermissionMode } from "@pigcode/contracts"
import { createThread } from "../services/thread-create"
import { AttachmentError } from "../services/attachments"
import { uninstallPluginAndClearDefault } from "./agents"
import { dispatchAgentCommand } from "./agent-commands"
import { subscribeDesktopThread } from "./desktop-thread-feed"
import { subscribeDesktopSidebar } from "./desktop-sidebar-feed"
import { HOST_COMMANDS, dispatchHostCommand } from "./host-commands"
import { desktopQueueRequests, dispatchDesktopQueue } from "./queued-message-commands"
import { TERMINAL_COMMANDS, dispatchTerminalCommand } from "./terminal-commands"
import { THREAD_COMMANDS, dispatchThreadCommand } from "./thread-commands"
import { ThreadFeed } from "./thread-feed"
import { WORKBENCH_COMMANDS, dispatchWorkbenchCommand } from "./workbench-commands"

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
  /** 页面打开或附着的终端输出订阅；按 terminalId 索引，重复附着先释放旧订阅。 */
  private readonly terminalSubscriptions = new Map<string, () => void>()
  /** 换过几次页面；页面换掉以后才完成的 terminal.open 会立即关闭该孤儿终端。 */
  private page = 0
  /** 正在处理桌面端自己发起的插件变更命令时，不向同一个桌面连接回声推送 plugin.changed。 */
  private localPluginMutations = 0

  constructor(
    private readonly ctx: Context,
    private readonly transport: HostTransport,
    private readonly feed = new ThreadFeed(ctx),
  ) {}

  /** 开始监听传输层消息。 */
  start(): void {
    this.disposers.push(
      this.transport.onMessage((message) => {
        void this.handle(message)
      }),
    )
    const schedules = this.ctx.get("schedules")
    if (schedules) {
      this.disposers.push(
        schedules.subscribe((change) =>
          this.transport.send({ jsonrpc: "2.0", method: "schedule.runChanged", params: change }),
        ),
      )
    }
    const plugins = this.ctx.get("plugins")
    if (plugins?.subscribe) {
      this.disposers.push(
        plugins.subscribe(() => {
          if (this.localPluginMutations > 0) return
          this.transport.send({ jsonrpc: "2.0", method: "plugin.changed", params: {} })
        }),
      )
    }
    this.disposers.push(
      subscribeDesktopSidebar(this.ctx, this.feed, (message) => this.transport.send(message)),
    )
  }

  /** 停止监听并释放所有订阅。 */
  stop(): void {
    this.releasePage()
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }

  /**
   * 页面换了（刷新或重新加载）：释放旧页面的线程与终端订阅，新页面会自己重新订阅。
   * 正在进行的 run 不受影响，它们的流式输出经同一个传输发给新页面。
   */
  releasePage(): void {
    this.page += 1
    for (const unsubscribe of this.subscriptions.values()) unsubscribe()
    this.subscriptions.clear()
    for (const unsubscribe of this.terminalSubscriptions.values()) unsubscribe()
    this.terminalSubscriptions.clear()
  }

  private async handle(message: unknown): Promise<void> {
    let request
    try {
      request = parseRpcRequest(message)
    } catch {
      return
    }
    try {
      let afterReply: (() => void) | undefined
      const result = await this.dispatch(request.method, request.params, (callback) => {
        afterReply = callback
      })
      this.transport.send(rpcSuccessSchema.parse({ jsonrpc: "2.0", id: request.id, result }))
      if (afterReply) queueMicrotask(afterReply)
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

  private async dispatch(
    method: string,
    params: unknown,
    onReply: (callback: () => void) => void,
  ): Promise<unknown> {
    if (!(method in commandSchemas)) throw new Error(`unknown method: ${method}`)
    const command = method as CommandMethod
    const parsed = commandSchemas[command].parse(params)
    if (desktopQueueRequests.has(command)) {
      return dispatchDesktopQueue(
        this.ctx,
        command,
        parsed,
        (id) => this.feed.changed(id),
        (threadId, event) => {
          if (
            this.subscriptions.has(threadId) &&
            !(event.type === "tool.outputDelta" && event.parentToolUseId)
          )
            return
          this.transport.send({
            jsonrpc: "2.0",
            method: "thread.delta",
            params: { threadId, event },
          })
        },
      )
    }
    if (THREAD_COMMANDS.has(command)) {
      return dispatchThreadCommand(this.ctx, command, parsed, (id) => this.feed.changed(id))
    }
    if (WORKBENCH_COMMANDS.has(command)) {
      return dispatchWorkbenchCommand(this.ctx, command, parsed)
    }
    if (TERMINAL_COMMANDS.has(command)) {
      return dispatchTerminalCommand(this.ctx, command, parsed, {
        subscriptions: this.terminalSubscriptions,
        getPage: () => this.page,
        send: (message) => this.transport.send(message),
        onReply,
      })
    }
    if (HOST_COMMANDS.has(command)) {
      return dispatchHostCommand(this.ctx, command, parsed)
    }

    switch (command) {
      case "relay.settings":
        return this.ctx.get("relaySettings")?.view() ?? { address: null, tokenConfigured: false }
      case "relay.testAndSave":
        return (
          this.ctx
            .get("relaySettings")
            ?.testAndSave(parsed as CommandParams<"relay.testAndSave">) ?? {
            status: "storage-unavailable",
          }
        )
      case "mobile.preview.getSettings":
        return (
          this.ctx.get("mobilePreview")?.getSettings() ?? {
            enabled: this.ctx.settings.get("mobile.preview.enabled") !== false,
            desktopUrls: [],
          }
        )
      case "mobile.preview.setEnabled": {
        const { enabled } = parsed as CommandParams<"mobile.preview.setEnabled">
        const preview = this.ctx.get("mobilePreview")
        if (preview) return preview.setEnabled(enabled)
        this.ctx.settings.set("mobile.preview.enabled", enabled)
        return { enabled, desktopUrls: [] }
      }
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
        // 终端也一样（会话里的和草稿里开的）：之后没有界面能关它，里面的进程会一直跑下去。
        this.ctx.get("terminal")?.closeProject(value.projectId)
        return project
      }
      case "thread.create":
        return createThread(this.ctx, parsed as CommandParams<"thread.create">)
      case "thread.subscribe": {
        const value = parsed as { threadId: string; cursor: number }
        this.subscriptions.get(value.threadId)?.()
        const subscription = subscribeDesktopThread(
          this.ctx,
          value.threadId,
          value.cursor,
          (message) => this.transport.send(message),
        )
        this.subscriptions.set(value.threadId, subscription.release)
        onReply(subscription.afterReply)
        return subscription.result
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
        return updateThreadModes(this.ctx, value.threadId, { permissionMode: value.permissionMode })
      }
      case "thread.setPlanMode": {
        const value = parsed as { threadId: string; planMode: boolean }
        return updateThreadModes(this.ctx, value.threadId, { planMode: value.planMode })
      }
      case "attachment.upload": {
        const value = parsed as CommandParams<"attachment.upload">
        if (value.threadId && !this.ctx.threads.get(value.threadId)) {
          throw new Error(`thread not found: ${value.threadId}`)
        }
        const cleaned = value.dataBase64.replace(/\s+/g, "")
        if (
          cleaned.length === 0 ||
          cleaned.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)
        ) {
          throw new AttachmentError("ATTACHMENT_UNSUPPORTED_TYPE", "invalid base64 image payload")
        }
        const attachment = this.ctx.attachments.saveStaging({
          buffer: Buffer.from(cleaned, "base64"),
          ...(value.fileName ? { fileName: value.fileName } : {}),
          ...(value.mimeType ? { declaredMimeType: value.mimeType } : {}),
          ownerDeviceKey: null,
        })
        return { attachment }
      }
      case "attachment.read": {
        const value = parsed as CommandParams<"attachment.read">
        const result = await this.ctx.attachments.readBytes(value.attachmentId, value.variant, {
          ...(value.threadId ? { threadId: value.threadId } : {}),
          ownerDeviceKey: null,
        })
        return {
          attachment: result.attachment,
          mimeType: result.mimeType,
          dataBase64: result.buffer.toString("base64"),
        }
      }
      case "run.list":
        return { runs: this.ctx.agents.listRuns() }
      case "run.interrupt": {
        const value = parsed as { runId: string }
        return { interrupted: this.ctx.agents.cancelRun(value.runId) }
      }
      case "run.respondApproval": {
        const value = parsed as CommandParams<"run.respondApproval">
        const outcome = this.ctx.agents.respondApproval(
          value.threadId,
          value.runId,
          value.requestId,
          value.decision,
        )
        return { ok: true, outcome }
      }
      case "run.answerQuestion": {
        const value = parsed as CommandParams<"run.answerQuestion">
        const outcome = this.ctx.agents.answerQuestion(
          value.threadId,
          value.runId,
          value.requestId,
          value.answers,
        )
        return { ok: true, outcome }
      }
      case "agent.detect":
      case "agent.cliUpdates":
      case "agent.setClaudeIdleCompaction":
      case "agent.acpRegistry":
      case "agent.prepareAcpRegistry":
      case "agent.auth":
      case "agent.cancelCliUpdate":
      case "agent.removeCli":
      case "agent.checkCliUpdates":
      case "agent.updateCli":
      case "agent.registered":
      case "agent.default":
      case "agent.models":
      case "agent.commands":
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
        return this.runLocalPluginMutation(() =>
          this.ctx.plugins.install((parsed as { spec: string }).spec),
        )
      case "plugin.installLocal":
        return this.runLocalPluginMutation(() =>
          this.ctx.plugins.installLocal((parsed as { sourceDir: string }).sourceDir),
        )
      case "plugin.enable":
        return this.runLocalPluginMutation(() =>
          this.ctx.plugins.enable((parsed as { id: string }).id),
        )
      case "plugin.disable":
        return this.runLocalPluginMutation(() =>
          this.ctx.plugins.disable((parsed as { id: string }).id),
        )
      case "plugin.uninstall":
        return this.runLocalPluginMutation(() =>
          uninstallPluginAndClearDefault(this.ctx, (parsed as { id: string }).id),
        )
      case "plugin.installFromMarketplace": {
        const { marketplace, name } = parsed as CommandParams<"plugin.installFromMarketplace">
        return this.runLocalPluginMutation(() =>
          this.ctx.plugins.installFromMarketplace(marketplace, name),
        )
      }
      case "plugin.update":
        return this.runLocalPluginMutation(() =>
          this.ctx.plugins.update((parsed as { id: string }).id),
        )
      case "plugin.reload":
        return this.ctx.plugins.reload()
      case "marketplace.list":
        return this.ctx.plugins.marketplaces()
      case "marketplace.add":
        return this.runLocalPluginMutation(() =>
          this.ctx.plugins.addMarketplace((parsed as { source: string }).source),
        )
      case "marketplace.refresh": {
        const { id, ifStale } = parsed as CommandParams<"marketplace.refresh">
        return this.ctx.plugins.refreshMarketplaces(id, ifStale)
      }
      case "marketplace.setEnabled": {
        const value = parsed as { id: string; enabled: boolean }
        return this.runLocalPluginMutation(() =>
          this.ctx.plugins.setMarketplaceEnabled(value.id, value.enabled),
        )
      }
      case "marketplace.remove":
        return this.runLocalPluginMutation(() =>
          this.ctx.plugins.removeMarketplace((parsed as { id: string }).id),
        )
      case "plugin.bootGraph":
        return this.ctx.plugins.bootGraph()
      case "schedule.list":
        return this.ctx.schedules.list()
      case "schedule.create":
        return this.ctx.schedules.create(parsed as CommandParams<"schedule.create">)
      case "schedule.update": {
        const { id, title, prompt, draft, rule, endsAt, enabled, execution } =
          parsed as CommandParams<"schedule.update">
        return this.ctx.schedules.update(id, {
          ...(title === undefined ? {} : { title }),
          ...(prompt === undefined ? {} : { prompt }),
          ...(draft === undefined ? {} : { draft }),
          ...(rule === undefined ? {} : { rule }),
          ...(endsAt === undefined ? {} : { endsAt }),
          ...(enabled === undefined ? {} : { enabled }),
          ...(execution === undefined ? {} : { execution }),
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
      default:
        throw new Error(`unsupported method: ${method}`)
    }
  }

  private async runLocalPluginMutation<T>(action: () => Promise<T>): Promise<T> {
    this.localPluginMutations += 1
    try {
      return await action()
    } finally {
      this.localPluginMutations -= 1
    }
  }
}
