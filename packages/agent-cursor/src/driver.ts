import { createHash, randomUUID } from "node:crypto"
import type { SDKModel } from "@cursor/sdk"
import { createRequire } from "node:module"
import { Worker } from "node:worker_threads"
import {
  NativeAgentDriver,
  nativeFeatures,
  promptText,
  type NativeSession,
} from "@pigcode/native-agent-runtime"
import type { AgentAuthAction, AgentAuthState, AgentEvent, AgentStatus } from "@pigcode/contracts"
import {
  settingEnvironment,
  settingString,
  type AgentInstanceContext,
  type AgentModelInfo,
  type AgentSettingsValues,
  type CreateSessionInput,
} from "@pigcode/plugin-sdk"
import { agentEnvironment } from "@pigcode/plugin-sdk/node"
import { cursorExecutionModes } from "./worker"
import type { CursorReply, CursorRequest, CursorWorkerOptions } from "./worker"

const require = createRequire(import.meta.url)
const workerUrl = import.meta.url.endsWith(".ts")
  ? new URL("./worker.ts", import.meta.url)
  : new URL(import.meta.url)
const authState = (
  phase: AgentAuthState["phase"],
  error: string | null = null,
): AgentAuthState => ({
  phase,
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  error,
  canLogout: phase === "connected",
  methods: [{ id: "browser", name: "Cursor" }],
})

/** SDK 在独立进程环境中运行，各实例的 PATH、代理及账号覆盖不会互相修改。 */
class CursorClient {
  private readonly worker: Worker
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private next = 0
  private stopped = false
  private closing?: Promise<void>
  onEvent?: (event: AgentEvent) => void
  onUrl?: (url: string) => void
  constructor(settings: AgentSettingsValues, instance: AgentInstanceContext) {
    const env = agentEnvironment(settingEnvironment(settings))
    const key = settingString(settings, "apiKey") || env.CURSOR_API_KEY
    const data: CursorWorkerOptions = {
      pigcodeCursor: true,
      directory: instance.dataDir,
      ...(key ? { key } : {}),
    }
    this.worker = new Worker(workerUrl, { workerData: data, env, execArgv: [] })
    this.worker.on("message", (message: CursorReply) => {
      if ("event" in message) return this.onEvent?.(message.event)
      if ("url" in message) return this.onUrl?.(message.url)
      const wait = this.pending.get(message.id)
      this.pending.delete(message.id)
      if ("error" in message) wait?.reject(new Error(message.error))
      else wait?.resolve(message.result)
    })
    const stop = (error: Error) => {
      this.stopped = true
      for (const wait of this.pending.values()) wait.reject(error)
      this.pending.clear()
    }
    this.worker.on("error", stop)
    this.worker.on("exit", () => stop(new Error("Cursor SDK worker exited")))
  }
  call<T>(request: CursorRequest, signal?: AbortSignal): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Cursor SDK worker is closed"))
    signal?.throwIfAborted()
    const id = ++this.next
    return new Promise<T>((resolve, reject) => {
      const aborted = () => {
        this.pending.delete(id)
        reject(signal?.reason)
      }
      signal?.addEventListener("abort", aborted, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", aborted)
          resolve(value as T)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", aborted)
          reject(error)
        },
      })
      this.worker.postMessage({ id, request })
    })
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      try {
        await this.call({ op: "close" }, AbortSignal.timeout(2_000))
      } catch {
        /* SDK 可能随本地 Agent 一同退出。 */
      } finally {
        await this.worker.terminate()
      }
    })()
    return this.closing
  }
}
function instanceOf(instance?: AgentInstanceContext): AgentInstanceContext {
  if (!instance) throw new Error("Cursor requires an Agent instance")
  return instance
}
interface Login {
  state: AgentAuthState
  client: CursorClient
  done: Promise<void>
}
export class CursorDriver extends NativeAgentDriver {
  readonly id = "cursor"
  readonly requiresInstance = true
  readonly displayName = "Cursor"
  readonly executionModes = cursorExecutionModes
  readonly features = { ...nativeFeatures, plan: true, usage: true, mcp: true }
  private readonly logins = new Map<string, Login>()
  private readonly catalogs = new Map<string, { settings: string; models: SDKModel[] }>()
  private catalogKey(settings: AgentSettingsValues) {
    return createHash("sha256").update(JSON.stringify(settings)).digest("hex")
  }
  private readonly clients = new Set<CursorClient>()
  private client(settings: AgentSettingsValues, instance?: AgentInstanceContext) {
    const client = new CursorClient(settings, instanceOf(instance))
    this.clients.add(client)
    return client
  }
  private async releaseClient(client: CursorClient) {
    try {
      await client.close()
    } finally {
      this.clients.delete(client)
    }
  }

  async detect(
    settings: AgentSettingsValues,
    instance?: AgentInstanceContext,
  ): Promise<AgentStatus> {
    try {
      require.resolve("@cursor/sdk")
    } catch {
      return {
        installed: false,
        version: null,
        authenticated: null,
        error: "Cursor SDK is unavailable",
      }
    }
    const client = this.client(settings, instance)
    try {
      return {
        installed: true,
        version: null,
        ...(await client.call<Pick<AgentStatus, "authenticated" | "email" | "account">>(
          { op: "status" },
          AbortSignal.timeout(12_000),
        )),
      }
    } catch (error) {
      return {
        installed: true,
        version: null,
        authenticated: null,
        error: error instanceof Error ? error.message : "Cursor account check failed",
      }
    } finally {
      await this.releaseClient(client)
    }
  }
  async listModels(
    settings: AgentSettingsValues,
    instance?: AgentInstanceContext,
  ): Promise<AgentModelInfo[]> {
    const client = this.client(settings, instance)
    try {
      const models = await client.call<SDKModel[]>({ op: "models" }, AbortSignal.timeout(15_000))
      this.catalogs.set(instanceOf(instance).dataDir, {
        settings: this.catalogKey(settings),
        models,
      })
      return models.map((model) => {
        const effort = model.parameters?.find((p) => p.id === "effort" || p.id === "reasoning")
        const defaultEffort = model.variants
          ?.find((v) => v.isDefault)
          ?.params.find((p) => p.id === effort?.id)?.value
        return {
          id: model.id,
          displayName: model.displayName,
          isDefault: model.id === "default",
          ...(model.description ? { description: model.description } : {}),
          ...(effort
            ? { efforts: effort.values.map((v) => v.value), defaultEffort: defaultEffort ?? null }
            : {}),
          ...(model.parameters?.some((p) => p.id === "fast") ? { fast: true } : {}),
        }
      })
    } finally {
      await this.releaseClient(client)
    }
  }
  protected async open(input: CreateSessionInput, signal: AbortSignal): Promise<NativeSession> {
    const client = this.client(input.settings ?? {}, input.instance)
    try {
      const catalog = this.catalogs.get(instanceOf(input.instance).dataDir)
      const descriptor =
        catalog?.settings === this.catalogKey(input.settings ?? {})
          ? catalog?.models.find((m) => m.id === input.model)
          : undefined
      const nativeId = await client.call<string>(
        {
          op: "open",
          ...(descriptor ? { descriptor } : {}),
          cwd: input.cwd,
          nativeId: input.nativeSessionId ?? null,
          model: input.model ?? null,
          plan: input.planMode === true,
          permission: input.permissionMode ?? "approval-required",
          ...(!input.planMode && input.mcp ? { mcp: input.mcp.stdioServer() } : {}),
        },
        AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      )
      return {
        nativeId,
        send: async (turn, runtime) => {
          client.onEvent = runtime.emit
          await client.call(
            {
              op: "send",
              text: promptText(turn),
              ...(turn.effort ? { effort: turn.effort } : {}),
              ...(turn.fast !== undefined ? { fast: turn.fast } : {}),
            },
            runtime.signal,
          )
        },
        interrupt: () => client.call<void>({ op: "cancel" }, AbortSignal.timeout(4_000)),
        close: () => this.releaseClient(client),
      }
    } catch (error) {
      await this.releaseClient(client)
      throw error
    }
  }
  readonly accountSetup = {
    auth: (request: AgentAuthAction, settings: AgentSettingsValues, scope: AgentInstanceContext) =>
      this.auth(request, settings, scope),
    close: async (scope: AgentInstanceContext) => {
      const login = this.logins.get(scope.dataDir)
      if (login) await this.releaseClient(login.client)
      await login?.done
      this.logins.delete(scope.dataDir)
      this.catalogs.delete(scope.dataDir)
    },
  }
  private async auth(
    request: AgentAuthAction,
    settings: AgentSettingsValues,
    scope: AgentInstanceContext,
  ): Promise<AgentAuthState> {
    const existing = this.logins.get(scope.dataDir)
    if (request.action === "status") {
      if (existing && (existing.state.flowId || !request.refresh)) return existing.state
      const status = await this.detect(settings, scope)
      const external = Boolean(
        settingString(settings, "apiKey") ||
        agentEnvironment(settingEnvironment(settings)).CURSOR_API_KEY,
      )
      return {
        ...authState(
          status.authenticated ? "connected" : status.error ? "failed" : "signed-out",
          status.error ?? null,
        ),
        canLogout: !external,
        methods: external ? [] : [{ id: "browser", name: "Cursor" }],
      }
    }
    if (request.action === "cancel") {
      if (!existing || existing.state.flowId !== request.flowId)
        throw new Error("Cursor sign-in is no longer active")
      existing.state = authState("cancelled")
      await this.releaseClient(existing.client)
      await existing.done
      return existing.state
    }
    if (request.action === "logout") {
      await this.accountSetup.close(scope)
      const client = this.client(settings, scope)
      try {
        await client.call({ op: "logout" }, AbortSignal.timeout(10_000))
        this.catalogs.delete(scope.dataDir)
        scope.invalidate()
        return authState("signed-out")
      } finally {
        await this.releaseClient(client)
      }
    }
    if (request.action !== "start") throw new Error("Complete sign-in on the Cursor website")
    if (existing?.state.flowId) return existing.state
    const client = this.client(settings, scope)
    const state = {
      ...authState("starting"),
      flowId: randomUUID(),
      expiresAt: Date.now() + 5 * 60_000,
    }
    const login: Login = { state, client, done: Promise.resolve() }
    this.logins.set(scope.dataDir, login)
    client.onUrl = (url) => {
      if (login.state.flowId && URL.parse(url)?.protocol === "https:")
        login.state = { ...login.state, authorizationUrl: url, phase: "waiting" }
    }
    login.done = (async () => {
      try {
        await client.call({ op: "login" }, AbortSignal.timeout(5 * 60_000))
        if (login.state.flowId) login.state = authState("connected")
      } catch (error) {
        if (login.state.flowId)
          login.state = authState(
            "failed",
            error instanceof Error ? error.message : "Cursor sign-in failed",
          )
      } finally {
        await this.releaseClient(client)
        this.catalogs.delete(scope.dataDir)
        scope.invalidate()
      }
    })()
    return state
  }
  override async close() {
    await super.close()
    this.catalogs.clear()
    await Promise.allSettled([...this.clients].map((c) => this.releaseClient(c)))
    await Promise.allSettled([...this.logins.values()].map((l) => l.done))
    this.logins.clear()
  }
}
