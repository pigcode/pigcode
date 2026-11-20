import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  NewSessionRequest,
  NewSessionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk"
import {
  DEFAULT_RUNTIME_MODE,
  normalizeRuntimeMode,
  type AgentFeatures,
  type AgentStatus,
} from "@pigcode/contracts"
import type {
  AgentCommandInfo,
  AgentDriver,
  AgentInstanceContext,
  AgentRuntime,
  AgentSessionHandle,
  AgentSettingsValues,
  CreateSessionInput,
  UserInput,
} from "@pigcode/plugin-sdk"
import { AntigravityAccounts } from "./auth"
import { configureSession, nativeCommands, readSessionModels, type SessionSetup } from "./catalog"
import { isAuthRequired, openAcp, requestOptions, type AcpProcess } from "./connection"
import { AntigravityInstallation, executableVersion, type Executable } from "./installation"
import { acpLaunch, instanceProfile, type AgyLaunch } from "./launch"
import { answerPermission, TurnEvents } from "./turn"
import { sessionBridge, type SessionBridge } from "./mcp"

const unavailable = "Antigravity session not found"
const signInRequired = "Sign in to this Antigravity instance in Agent settings"
const unsupported = "Update Antigravity CLI to a compatible version"

interface Session {
  rpc: AcpProcess
  executable: Executable
  instance: AgentInstanceContext
  nativeId: string
  setup: SessionSetup
  canClose: boolean
  bridge: SessionBridge
  fresh: boolean
  runtime?: AgentRuntime
  events?: TurnEvents
  prompting: boolean
  cancelled: boolean
  planMode: boolean
  windDown?: ReturnType<typeof setTimeout>
  done: Promise<void>
  resolveDone(): void
  closing?: Promise<void>
}

function requireInstance(instance: AgentInstanceContext | undefined): AgentInstanceContext {
  if (!instance) throw new Error("Antigravity requires an Agent instance data directory")
  return instance
}

export class AntigravityDriver implements AgentDriver {
  readonly id = "antigravity"
  readonly displayName = "Antigravity"
  readonly executionModes = { plan: true }
  readonly modelSwitch = "resume"
  readonly features: AgentFeatures = {
    streaming: true,
    approvals: true,
    questions: true,
    plan: true,
    resume: true,
    fork: false,
    rollback: false,
    checkpoint: false,
    subagents: false,
    mcp: true,
    images: false,
    usage: true,
    modelCatalog: true,
    nativeSessionId: true,
  }

  private readonly installation: AntigravityInstallation
  private readonly accounts: AntigravityAccounts
  private readonly sessions = new Map<string, Session>()
  private readonly processes = new Map<AcpProcess, string>()
  private readonly grants = new Map<string, { instance: string; values: Set<string> }>()
  private readonly commands = new Map<string, Map<string, AgentCommandInfo[]>>()
  private closed = false

  constructor(fetchRelease?: typeof fetch) {
    this.installation = new AntigravityInstallation(fetchRelease)
    this.accounts = new AntigravityAccounts(
      this.installation,
      async (launch, instance, signal) => {
        await this.readCatalog(launch, instance, signal)
      },
      (instance) => this.closeInstance(instance),
    )
  }

  readonly accountSetup = {
    auth: (...args: Parameters<AntigravityAccounts["auth"]>) => this.accounts.auth(...args),
    close: (instance: AgentInstanceContext) => this.accounts.close(instance),
  }

  prepareCliUpdate(settings: AgentSettingsValues, instance?: AgentInstanceContext) {
    return this.installation.prepare(settings, requireInstance(instance))
  }

  removeManagedCli(instance: AgentInstanceContext, configured: readonly AgentSettingsValues[]) {
    return this.installation.remove(instance, configured)
  }

  async detect(
    settings: AgentSettingsValues,
    instance?: AgentInstanceContext,
  ): Promise<AgentStatus> {
    const scope = requireInstance(instance)
    const command = await this.installation.resolve(settings, scope)
    const version = command ? await executableVersion(command, settings) : null
    if (!version) return { installed: false, version, authenticated: null, command }
    const [major = 0, minor = 0] = version.split(".").map(Number)
    if (major < 1 || (major === 1 && minor < 5))
      return { installed: true, version, command, authenticated: false, error: unsupported }
    const auth = await this.accounts.status(scope)
    return {
      installed: true,
      version,
      command,
      authenticated: auth.phase === "connected",
      account: auth.phase === "connected" ? "Google" : null,
    }
  }

  async listModels(settings: AgentSettingsValues, instance?: AgentInstanceContext) {
    const scope = requireInstance(instance)
    if (this.accounts.busy(scope) || (await this.accounts.status(scope)).phase !== "connected")
      return []
    const executable = await this.installation.acquire(settings, scope)
    let cwd: string | undefined
    try {
      cwd = await mkdtemp(join(tmpdir(), "pigcode-agy-models-"))
      const launch = await acpLaunch(
        executable.command,
        settings,
        await instanceProfile(scope),
        cwd,
      )
      if (this.accounts.busy(scope)) return []
      return await this.readCatalog(launch, scope)
    } catch (error) {
      if (!isAuthRequired(error)) throw error
      this.accounts.requireSignIn(scope)
      return []
    } finally {
      executable.release()
      if (cwd) await rm(cwd, { recursive: true, force: true })
    }
  }

  async listCommands(
    settings: AgentSettingsValues,
    cwd: string | null,
    instance?: AgentInstanceContext,
  ) {
    const scope = requireInstance(instance)
    if (this.accounts.busy(scope) || (await this.accounts.status(scope)).phase !== "connected")
      return []
    const list = this.commands.get(scope.dataDir)
    if (cwd && list?.has(cwd)) return list.get(cwd)!
    if (!list?.has("")) await this.listModels(settings, scope)
    return this.commands.get(scope.dataDir)?.get("") ?? []
  }

  private open(
    launch: AgyLaunch,
    instance: AgentInstanceContext,
    handlers?: Parameters<typeof openAcp>[1],
  ) {
    if (this.closed) throw new Error("Antigravity is closing")
    const rpc = openAcp(launch, handlers)
    this.processes.set(rpc, instance.dataDir)
    return rpc
  }

  private async closeProcess(rpc: AcpProcess) {
    try {
      await rpc.close()
    } finally {
      this.processes.delete(rpc)
    }
  }

  private rememberCommands(
    scope: AgentInstanceContext,
    cwd: string,
    notification: SessionNotification,
  ) {
    if (notification.update.sessionUpdate !== "available_commands_update") return
    const commands = this.commands.get(scope.dataDir) ?? new Map<string, AgentCommandInfo[]>()
    commands.set(cwd, nativeCommands(notification.update.availableCommands))
    this.commands.set(scope.dataDir, commands)
  }

  private async readCatalog(
    launch: AgyLaunch,
    instance: AgentInstanceContext,
    signal?: AbortSignal,
  ) {
    const deadline = AbortSignal.timeout(90_000)
    signal = signal ? AbortSignal.any([signal, deadline]) : deadline
    const rpc = this.open(launch, instance, {
      update: (update) => this.rememberCommands(instance, "", update),
    })
    try {
      const info = await rpc.initialize(signal)
      const setup = await rpc.agent.request(
        "session/new",
        { cwd: launch.cwd, mcpServers: [] },
        requestOptions(signal),
      )
      const models = await readSessionModels(rpc, setup, signal)
      await this.closeNative(
        rpc,
        setup.sessionId,
        Boolean(info.agentCapabilities?.sessionCapabilities?.close),
        signal,
      )
      return models
    } finally {
      await this.closeProcess(rpc)
    }
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionHandle> {
    const instance = requireInstance(input.instance)
    if (this.accounts.busy(instance)) throw new Error("Antigravity account setup is in progress")
    const settings = input.settings ?? {}
    if ((await this.accounts.status(instance)).phase !== "connected")
      throw new Error(signInRequired)
    const id = input.sessionId ?? `antigravity_${randomUUID()}`
    const previous = this.sessions.get(id)
    if (previous) await previous.done
    input.signal?.throwIfAborted()
    const executable = await this.installation.acquire(settings, instance)
    let rpc: AcpProcess | undefined
    let bridge: SessionBridge | undefined
    try {
      const launch = await acpLaunch(
        executable.command,
        settings,
        await instanceProfile(instance),
        input.cwd,
      )
      input.signal?.throwIfAborted()
      if (this.accounts.busy(instance)) throw new Error("Antigravity account setup is in progress")
      if (input.mcp) launch.args.push("--process-per-session")
      const active: { state?: Session } = {}
      const permissionMode = normalizeRuntimeMode(
        input.permissionMode ?? DEFAULT_RUNTIME_MODE,
        this.id,
      )
      if (!permissionMode) throw new Error("Unsupported Antigravity permission mode")
      const planMode = input.planMode ?? false
      const approved = this.grants.get(id) ?? {
        instance: instance.dataDir,
        values: new Set<string>(),
      }
      rpc = this.open(launch, instance, {
        update: (notification) => {
          const { state } = active
          if (state && notification.sessionId !== state.nativeId) return
          this.rememberCommands(instance, input.cwd, notification)
          if (state?.prompting) {
            if (notification.update.sessionUpdate === "current_mode_update")
              state.planMode = notification.update.currentModeId === "plan"
            state.events?.update(notification.update)
          }
        },
        approval: async (request) => {
          const { state } = active
          if (!state?.runtime || request.sessionId !== state.nativeId || state.cancelled)
            return { outcome: { outcome: "cancelled" } }
          return answerPermission(
            request,
            state.runtime,
            permissionMode,
            state.planMode,
            approved.values,
          )
        },
      })
      const info = await rpc.initialize(input.signal)
      bridge = await sessionBridge(
        input.mcp,
        Boolean(info.agentCapabilities?.mcpCapabilities?.http),
      )
      const args = { cwd: input.cwd, mcpServers: bridge.servers }
      const original = input.nativeSessionId
      let setup: SessionSetup
      let nativeId: string
      if (original) {
        setup = await rpc.agent.request(
          "session/resume",
          { ...args, sessionId: original },
          requestOptions(input.signal),
        )
        nativeId = original
      } else {
        const started = await rpc.agent.request<NewSessionResponse, NewSessionRequest>(
          "session/new",
          args,
          requestOptions(input.signal),
        )
        setup = started
        nativeId = started.sessionId
      }
      if (!nativeId) throw new Error("Antigravity returned no native session ID")
      let resolveDone = () => {}
      const done = new Promise<void>((resolve) => {
        resolveDone = resolve
      })
      const state = (active.state = {
        rpc,
        bridge,
        executable,
        instance,
        nativeId,
        setup,
        done,
        resolveDone,
        fresh: !original,
        canClose: Boolean(info.agentCapabilities?.sessionCapabilities?.close),
        prompting: false,
        cancelled: false,
        planMode,
      })
      this.sessions.set(id, state)
      this.grants.set(id, approved)
      return {
        id,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: nativeId,
        permissionMode,
        planMode,
        model: input.model ?? null,
      }
    } catch (error) {
      if (rpc) await this.closeProcess(rpc)
      bridge?.close()
      executable.release()
      if (isAuthRequired(error)) {
        this.accounts.requireSignIn(instance)
        throw new Error(signInRequired)
      }
      throw error
    }
  }

  async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime): Promise<void> {
    const state = this.sessions.get(session.id)
    if (!state) throw new Error(unavailable)
    state.runtime = runtime
    state.events = new TurnEvents(runtime)
    const cancel = () => this.cancel(state)
    runtime.signal.addEventListener("abort", cancel, { once: true })
    try {
      runtime.signal.throwIfAborted()
      if (state.fresh || session.nativeSessionId !== state.nativeId)
        runtime.emit({ type: "session.started", nativeSessionId: state.nativeId })
      await configureSession(state, session, input, runtime.signal)
      runtime.signal.throwIfAborted()
      state.prompting = true
      const text = input.handoff ? `${input.handoff}\n\n${input.text}` : input.text
      const result = await state.rpc.agent.request("session/prompt", {
        sessionId: state.nativeId,
        prompt: [{ type: "text", text }],
      })
      state.events.finish()
      if (state.cancelled || result.stopReason === "cancelled")
        runtime.emit({ type: "run.interrupted" })
      else if (result.stopReason !== "end_turn")
        throw new Error(`Antigravity stopped: ${result.stopReason}`)
    } catch (error) {
      state.events.finish()
      if (state.cancelled || runtime.signal.aborted) runtime.emit({ type: "run.interrupted" })
      else if (isAuthRequired(error)) {
        this.accounts.requireSignIn(state.instance)
        throw new Error(signInRequired)
      } else throw error
    } finally {
      runtime.signal.removeEventListener("abort", cancel)
      await this.finish(session.id, state)
    }
  }

  private cancel(state: Session) {
    if (state.cancelled) return
    state.cancelled = true
    if (state.prompting) {
      void state.rpc.agent
        .notify("session/cancel", { sessionId: state.nativeId })
        .catch(() => undefined)
      state.windDown = setTimeout(() => void this.closeProcess(state.rpc), 5_000)
      state.windDown.unref()
    } else {
      void this.closeProcess(state.rpc)
    }
  }

  async interrupt(session: AgentSessionHandle) {
    const state = this.sessions.get(session.id)
    if (!state) return
    this.cancel(state)
    await state.done
  }

  async dispose(session: AgentSessionHandle) {
    const state = this.sessions.get(session.id)
    if (state) await this.finish(session.id, state)
    this.grants.delete(session.id)
  }

  private async closeNative(rpc: AcpProcess, id: string, supported: boolean, signal?: AbortSignal) {
    if (supported && !signal?.aborted)
      await rpc.agent
        .request("session/close", { sessionId: id }, requestOptions(signal, 3_000))
        .catch(() => undefined)
  }

  private finish(id: string, state: Session): Promise<void> {
    state.closing ??= (async () => {
      clearTimeout(state.windDown)
      try {
        await this.closeNative(state.rpc, state.nativeId, state.canClose)
        await this.closeProcess(state.rpc)
      } finally {
        state.bridge.close()
        state.executable.release()
        if (this.sessions.get(id) === state) this.sessions.delete(id)
        state.resolveDone()
      }
    })()
    return state.closing
  }

  private async closeInstance(instance: AgentInstanceContext) {
    this.commands.delete(instance.dataDir)
    for (const [id, grant] of this.grants) {
      if (grant.instance === instance.dataDir) this.grants.delete(id)
    }
    await Promise.all(
      [...this.processes.entries()].flatMap(([rpc, directory]) =>
        directory === instance.dataDir ? [this.closeProcess(rpc)] : [],
      ),
    )
    await Promise.all(
      [...this.sessions].flatMap(([id, state]) =>
        state.instance.dataDir === instance.dataDir ? [this.finish(id, state)] : [],
      ),
    )
  }

  isSessionNotFound(message: string): boolean {
    return (
      message === unavailable ||
      /failed to read session .+; retry, or load it|\bsession\b.*\bnot found\b/i.test(message)
    )
  }

  async close() {
    this.closed = true
    await this.accounts.dispose()
    await Promise.all([...this.processes.keys()].map((rpc) => this.closeProcess(rpc)))
    await Promise.all([...this.sessions].map(([id, state]) => this.finish(id, state)))
    this.grants.clear()
    this.commands.clear()
  }
}
