import { DEFAULT_RUNTIME_MODE } from "@pigcode/contracts"
/** Codex adapter：每 session 一个 app-server 子进程，经 NDJSON JSON-RPC 通信。 */
import type { AgentFeatures } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import { sharedCodexHome } from "./shadow-home"
import { prepareCodexCliUpdate } from "./cli-update"
import { codexExecutionModes, createThreadParams } from "./permissions"
import {
  HOST_VERSION,
  type CreateSessionInput,
  type AgentCommandInfo,
  type AgentDriver,
  type AgentModelInfo,
  type AgentRuntime,
  type AgentSessionHandle,
  type AgentInstanceContext,
  type AgentSettingsValues,
  type AgentStatus,
  type UserInput,
} from "@pigcode/plugin-sdk"
import { ManagedCodexRuntime } from "./managed-runtime"
import { CodexAccounts } from "./login"
import { CodexRpcClient } from "./client"
export { injectHandoff } from "./protocol"
import { interruptTurn, waitForTurn } from "./turn-wait"
import { codexStatus, detectCodex, type CodexDetection } from "./detect"
import { prepareCodexLaunch, launchKey, type CodexLaunch, type PrepareCodexLaunch } from "./launch"
import { parseCodexModels } from "./models"
import { parseCodexSkills } from "./skills"
import { flushNotices, mcpStartupNotice, rememberNotice, type NoticeState } from "./notice"
import { StdioCodexTransport, type CodexTransport } from "./transport"
import {
  bindTurnHandlers,
  buildTurnInput,
  buildTurnStartParams,
  type CodexSessionState,
} from "./turn"

/** driver 的可选依赖；测试替换传输与检测。 */
export interface CodexDriverOptions {
  managedRuntime?: ManagedCodexRuntime
  transportFactory?: (launch: CodexLaunch) => CodexTransport
  detect?: (launch: CodexLaunch) => Promise<CodexDetection>
}

async function initializeCodex(client: CodexRpcClient) {
  await client.request("initialize", {
    clientInfo: { name: "pigcode", title: "Pigcode", version: HOST_VERSION },
    capabilities: { experimentalApi: true },
  })
  client.notify("initialized", {})
}

/** 基于 `codex app-server --stdio` 的 Codex driver。 */
export class CodexDriver implements AgentDriver {
  private cliRevision = 0
  private readonly managed: ManagedCodexRuntime
  private readonly launch: PrepareCodexLaunch = (settings, scope, signal) =>
    prepareCodexLaunch(this.managed, settings, scope, signal)
  prepareCliUpdate(settings: AgentSettingsValues, instance?: AgentInstanceContext) {
    return prepareCodexCliUpdate(
      settings,
      () => {
        this.cliRevision += 1
      },
      this.managed,
      instance,
    )
  }
  readonly executionModes = codexExecutionModes
  readonly id = "codex"
  readonly displayName = "Codex"
  // M2 桥接审批、计划、用量与 resume；M5 起通过 `config.mcp_servers` 注入插件工具。
  // fork 走 app-server 的 thread/fork（见 createSession），Host 切模型时已经在用，所以是 true。
  // request_user_input 接提问卡片；rollback/checkpoint/subagents 尚未实现。
  readonly features: AgentFeatures = {
    streaming: true,
    approvals: true,
    questions: true,
    plan: true,
    resume: true,
    fork: true,
    rollback: false,
    checkpoint: false,
    subagents: false,
    mcp: true,
    images: true,
    usage: true,
    modelCatalog: true,
    nativeSessionId: true,
  }

  private readonly sessions = new Map<string, CodexSessionState>()
  /** 所有还开着的 app-server，包括 session 建到一半和临时拉模型目录的。 */
  private readonly clients = new Set<CodexRpcClient>()
  /** 正在结束的 app-server。注册表注销 driver 时不等 dispose，所以 close 要等这里的全部结束，否则 Host 一退出就没人强制结束它们了。 */
  private readonly ending = new Set<Promise<void>>()
  private readonly transportFactory: (launch: CodexLaunch) => CodexTransport
  private readonly probe: (launch: CodexLaunch) => Promise<CodexDetection>

  readonly accountSetup = new CodexAccounts(
    this.launch,
    (launch) => this.openClient(launch),
    (client) => this.closeClient(client),
    initializeCodex,
    async (scope) => {
      const closing: Promise<void>[] = []
      for (const [id, session] of this.sessions) {
        if (session.scope !== scope.dataDir) continue
        this.sessions.delete(id)
        closing.push(this.closeClient(session.client))
      }
      await Promise.all(closing)
    },
  )

  constructor(options: CodexDriverOptions = {}) {
    this.managed = options.managedRuntime ?? new ManagedCodexRuntime()
    this.transportFactory =
      options.transportFactory ??
      ((launch) => new StdioCodexTransport(launch.command, launch.args, launch.env, launch.cwd))
    this.probe =
      options.detect ??
      ((launch) =>
        detectCodex({
          command: launch.command,
          env: launch.env,
          versionOnly: launch.isolatedAccount,
        }))
  }

  /**
   * 只读检测：版本与登录状态，用设置页里的可执行文件与 CODEX_HOME。
   * 装着时再问 app-server 的 `account/read` 要登录方式、订阅与邮箱；问不到就用 `login status` 的结论。
   */
  async detect(
    settings: AgentSettingsValues,
    instance?: AgentInstanceContext,
  ): Promise<AgentStatus> {
    const launch = await this.launch(settings, instance)
    const detection = launch ? await this.probe(launch) : null
    const account = launch && detection?.installed ? await this.accountSetup.read(launch) : null
    return codexStatus(
      detection,
      settings.setupMode === "managed",
      Boolean(launch?.isolatedAccount),
      account,
    )
  }

  /** 启动 app-server 并创建或恢复原生 thread。 */
  async createSession(input: CreateSessionInput): Promise<AgentSessionHandle> {
    // 复用仍在运行的 app-server：同一原生 thread 的后续 run 不需要重新初始化。
    // 权限模式或模型变了就不复用，下面用 thread/resume 带上新的 sandbox 与审批策略。
    const permissionMode = input.permissionMode ?? DEFAULT_RUNTIME_MODE
    const model = input.model ?? null
    input.signal?.throwIfAborted()
    const launch = await this.launch(input.settings, input.instance)
    if (!launch) throw new Error("Set up the Codex runtime by signing in to this instance")
    input.signal?.throwIfAborted()
    if (input.instance && this.accountSetup.busy(input.instance))
      throw new Error("Codex account setup is in progress")
    const key = `${launchKey(launch)}:${this.cliRevision}`
    const reusable = input.forkFromNativeSessionId
      ? undefined
      : input.nativeSessionId
        ? this.sessions.get(input.threadId)
        : undefined
    if (
      reusable?.nativeThreadId &&
      reusable.nativeThreadId === input.nativeSessionId &&
      reusable.scope === input.instance?.dataDir &&
      reusable.permissionMode === permissionMode &&
      reusable.model === model &&
      reusable.launchKey === key
    ) {
      return {
        id: input.sessionId ?? `codex_${randomUUID()}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: reusable.nativeThreadId,
        permissionMode: input.permissionMode ?? DEFAULT_RUNTIME_MODE,
        planMode: input.planMode ?? input.permissionMode === "plan",
        model: input.model ?? null,
      }
    }

    const client = this.openClient(launch)
    // MCP 桥起不来时 app-server 只发一条通知，界面上否则没有任何线索（#57）。
    // 通知在 thread/start 之后就到，那时 run 还没开始，先攒在 session 里，等 send 时补发。
    const notice: NoticeState = { pending: [], told: new Set() }
    client.onNotification("mcpServer/startupStatus/updated", (params) => {
      const found = mcpStartupNotice(params)
      if (found) rememberNotice(notice, found)
    })
    try {
      await initializeCodex(client)
      const params = createThreadParams(input)
      // 同一 Agent 切换优先原生 fork；fork 返回的新 thread id 用于后续 turn。
      const forkFrom = input.forkFromNativeSessionId
      const response = forkFrom
        ? ((await client.request("thread/fork", {
            threadId: forkFrom,
            ...params,
          })) as { thread?: { id?: string }; model?: string })
        : input.nativeSessionId
          ? ((await client.request("thread/resume", {
              threadId: input.nativeSessionId,
              ...params,
            })) as { thread?: { id?: string }; model?: string })
          : ((await client.request("thread/start", params)) as {
              thread?: { id?: string }
              model?: string
            })
      const nativeThreadId =
        response.thread?.id ?? (forkFrom ? null : (input.nativeSessionId ?? null))
      // 不同 Pigcode 线程可从同一共享 rollout 续聊，各自持有自己账号的进程。
      const stateKey = input.threadId
      const previous = this.sessions.get(stateKey)
      if (previous) {
        void this.closeClient(previous.client)
        this.sessions.delete(stateKey)
      }
      this.sessions.set(stateKey, {
        finished: false,
        client,
        nativeThreadId,
        turnId: null,
        interruptRequested: false,
        permissionMode,
        model,
        effectiveModel: model ?? response.model ?? null,
        launchKey: key,
        scope: input.instance?.dataDir,
        notice,
      })
      return {
        id: input.sessionId ?? `codex_${randomUUID()}`,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: nativeThreadId,
        permissionMode: input.permissionMode ?? DEFAULT_RUNTIME_MODE,
        planMode: input.planMode ?? input.permissionMode === "plan",
        model: input.model ?? null,
      }
    } catch (error) {
      // 初始化失败时结束子进程，避免泄漏 app-server。
      void this.closeClient(client)
      throw error
    }
  }

  /** 发起一个 turn，消费该 turn 的全部通知直到终态或中断。 */
  async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime): Promise<void> {
    const state = this.stateFor(session)
    if (!state?.nativeThreadId) throw new Error("codex thread not started")
    const client = state.client
    state.interruptRequested = false
    state.finished = false
    // 启动期攒下的提示在这里补发：此刻 run 已经建立，事件有对应的 runId。
    flushNotices(state.notice, runtime)
    const disposeHandlers = bindTurnHandlers(client, state, runtime)
    const turnInput = await buildTurnInput(client, state.nativeThreadId, input)
    const onAbort = (): void => {
      void interruptTurn(state)
    }
    runtime.signal.addEventListener("abort", onAbort, { once: true })
    try {
      const started = (await client.request(
        "turn/start",
        buildTurnStartParams(session, state, state.nativeThreadId, input, turnInput),
      )) as { turn?: { id?: string } }
      state.fast = input.fast === true
      state.turnId = started.turn?.id ?? null
      if (runtime.signal.aborted) {
        // abort 可能早于 turn/start 响应；此时才能拿到 turnId 并发送中断。
        void interruptTurn(state)
        return
      }
      await waitForTurn(client, state.turnId, runtime.signal)
    } finally {
      runtime.signal.removeEventListener("abort", onAbort)
      disposeHandlers()
      state.turnId = null
    }
  }

  /** 模型目录；读不到时返回空目录，不影响设置页。 */
  async listModels(
    settings: AgentSettingsValues = {},
    instance?: AgentInstanceContext,
  ): Promise<AgentModelInfo[]> {
    return this.ask(settings, instance, async (client) =>
      parseCodexModels(await client.request("model/list", {})),
    )
  }

  /** 输入框 `$` 菜单里的 Skill；请求项目的完整目录，包括刚安装的条目。 */
  async listCommands(
    settings: AgentSettingsValues,
    cwd: string | null,
    instance?: AgentInstanceContext,
  ): Promise<AgentCommandInfo[]> {
    const params = { ...(cwd ? { cwds: [cwd] } : {}), forceReload: true }
    return this.ask(
      settings,
      instance,
      async (client) => parseCodexSkills(await client.request("skills/list", params), cwd),
      cwd ?? undefined,
    )
  }

  /** 临时启动一个 app-server 做一次只读请求；失败时返回空数组。 */
  private async ask<T>(
    settings: AgentSettingsValues,
    instance: AgentInstanceContext | undefined,
    read: (client: CodexRpcClient) => Promise<T[]>,
    cwd?: string,
  ): Promise<T[]> {
    const launch = await this.launch(settings, instance)
    if (!launch) return []
    const client = this.openClient({ ...launch, ...(cwd ? { cwd } : {}) })
    try {
      await initializeCodex(client)
      return await read(client)
    } catch {
      return []
    } finally {
      void this.closeClient(client)
    }
  }

  /** 中断该 session 当前活跃的 turn；没有活跃 turn 时为空操作。 */
  async interrupt(session: AgentSessionHandle): Promise<void> {
    const state = this.stateFor(session)
    if (!state) return
    await interruptTurn(state)
  }

  /** 关闭 app-server 并释放 session 状态。 */
  async dispose(session: AgentSessionHandle): Promise<void> {
    const state = this.stateFor(session)
    if (!state) return
    this.sessions.delete(session.threadId)
    await this.closeClient(state.client)
  }

  /** rollout 放在 CODEX_HOME（缺省 ~/.codex）下：目录相同的实例能接着用彼此的 thread。 */
  continuationKey(settings: AgentSettingsValues): string {
    return `codex:${sharedCodexHome(settings)}`
  }

  /** `thread/resume` 找不到原生 thread 时，app-server 0.167 回 `no rollout found for thread id <id>`。 */
  isSessionNotFound(message: string): boolean {
    return /no rollout found for thread id/i.test(message)
  }

  /** 插件停用时关闭所有 app-server，包括空闲等待复用的。 */
  async close(): Promise<void> {
    await this.accountSetup.dispose()
    this.sessions.clear()
    for (const client of [...this.clients]) void this.closeClient(client)
    await Promise.all(this.ending)
  }

  /** 启动一个 app-server 并记下来，插件停用时都要结束。 */
  private openClient(launch: CodexLaunch): CodexRpcClient {
    const client = new CodexRpcClient(this.transportFactory(launch))
    this.clients.add(client)
    return client
  }

  /** 结束 app-server；不管调用方等不等，close 都会等它结束。 */
  private closeClient(client: CodexRpcClient): Promise<void> {
    this.clients.delete(client)
    const done = client.close().finally(() => {
      this.ending.delete(done)
    })
    this.ending.add(done)
    return done
  }

  /** 由 Pigcode 线程持有进程；原生 ID 相同的其它线程可能使用另一个账号。 */
  private stateFor(session: AgentSessionHandle): CodexSessionState | undefined {
    const state = this.sessions.get(session.threadId)
    return state?.nativeThreadId === session.nativeSessionId ? state : undefined
  }
}
