import { randomUUID } from "node:crypto"
import type { NewSessionResponse, SessionNotification } from "@agentclientprotocol/sdk"
import { DEFAULT_RUNTIME_MODE, normalizeRuntimeMode } from "@pigcode/contracts"
import type {
  AgentCommandInfo,
  AgentRuntime,
  AgentSessionHandle,
  CreateSessionInput,
  UserInput,
} from "@pigcode/plugin-sdk"
import {
  authenticateAcp,
  isMissingAcpSession,
  setupAcpSession,
  openAcp,
  requestOptions,
  type AcpLaunch,
  type AcpProcess,
} from "./connection"
import {
  configureSession,
  nativeCommands,
  readSessionModels,
  selectConfig,
  type SessionSetup,
} from "./catalog"
import { sessionBridge, type SessionBridge } from "./mcp"
import {
  applySessionUpdate,
  buildPromptPayload,
  buildSessionHandle,
  canReuseLiveSession,
  type AcpLifecycle,
  type AcpRuntimeOptions,
  type AcpSession,
  type AcpTurn,
} from "./session"
import { answerPermission, TurnEvents } from "./turn"

export type { AcpRuntimeOptions }
export const missingSession = "ACP native session unavailable"

export class AcpRuntime {
  private readonly sessions = new Map<string, AcpSession>()
  private readonly processes = new Map<AcpProcess, string>()
  private readonly grants = new Map<string, { scope: string; approvals: Set<string> }>()
  private readonly commands = new Map<string, Map<string, AgentCommandInfo[]>>()
  private closed = false

  constructor(private readonly options: AcpRuntimeOptions) {}

  open(launch: AcpLaunch, scope: string, handlers?: Parameters<typeof openAcp>[1]) {
    if (this.closed) throw new Error("ACP runtime is closing")
    const rpc = openAcp(launch, handlers, this.options)
    this.processes.set(rpc, scope)
    return rpc
  }

  async closeProcess(rpc: AcpProcess) {
    try {
      await rpc.close()
    } finally {
      this.processes.delete(rpc)
    }
  }

  readCommands(scope: string, cwd: string | null) {
    const records = this.commands.get(scope)
    return (cwd && records?.get(cwd)) || records?.get("")
  }

  private rememberCommands(scope: string, cwd: string, event: SessionNotification) {
    if (event.update.sessionUpdate !== "available_commands_update") return
    const records = this.commands.get(scope) ?? new Map<string, AgentCommandInfo[]>()
    records.set(cwd, nativeCommands(event.update.availableCommands))
    this.commands.set(scope, records)
  }

  async readCatalog(launch: AcpLaunch, scope: string, signal?: AbortSignal) {
    const deadline = AbortSignal.timeout(90_000)
    const probeSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    const rpc = this.open(launch, scope, {
      update: (update) => this.rememberCommands(scope, "", update),
    })
    try {
      const info = await rpc.initialize(probeSignal)
      await authenticateAcp(rpc, launch, probeSignal)
      this.options.onInitialize?.(scope, info)
      const setup = await setupAcpSession(
        rpc,
        this.options.authMethod?.(launch),
        () =>
          rpc.agent.request(
            "session/new",
            {
              cwd: launch.cwd,
              mcpServers: [],
              ...(this.options.sessionMeta ? { _meta: this.options.sessionMeta } : {}),
            },
            requestOptions(probeSignal),
          ),
        probeSignal,
      )
      this.options.onSession?.(scope, setup, info)
      const models = await readSessionModels(
        rpc,
        setup,
        probeSignal,
        this.options.probeModelEfforts,
        this.options.effortId,
      )
      await this.closeNative(
        rpc,
        setup.sessionId,
        Boolean(info.agentCapabilities?.sessionCapabilities?.close),
        probeSignal,
      )
      return models
    } finally {
      await this.closeProcess(rpc)
    }
  }

  async createSession(
    input: CreateSessionInput,
    launch: AcpLaunch,
    scope: string,
    lifecycle: AcpLifecycle = {},
  ): Promise<AgentSessionHandle> {
    const id = input.sessionId ?? `${this.options.id}_${randomUUID()}`
    const prior = this.sessions.get(id)
    const invocation = JSON.stringify([launch.command, launch.args, launch.cwd, launch.env])
    const policy = normalizeRuntimeMode(
      input.permissionMode ?? DEFAULT_RUNTIME_MODE,
      this.options.id,
    )
    let rpc: AcpProcess | undefined
    let bridge: SessionBridge | undefined
    try {
      if (!policy) throw new Error("Unsupported ACP permission mode")
      await prior?.turn?.done
      input.signal?.throwIfAborted()
      if (canReuseLiveSession(prior, scope, input.nativeSessionId, invocation)) {
        prior.policy = policy
        lifecycle.release?.()
        return buildSessionHandle(id, input, prior.nativeId, policy)
      }
      if (prior) await this.finish(id, prior)
      const active: { state?: AcpSession } = {}
      const grants = this.grants.get(id) ?? { scope, approvals: new Set<string>() }
      rpc = this.open(launch, scope, {
        update: (event) => {
          const { state } = active
          if (state && state.nativeId !== event.sessionId) return
          this.rememberCommands(scope, input.cwd, event)
          if (state) applySessionUpdate(state, event)
        },
        approval: (request) => {
          const state = active.state
          if (!state?.turn || state.turn.cancelled || request.sessionId !== state.nativeId)
            return Promise.resolve({ outcome: { outcome: "cancelled" } })
          return answerPermission(
            request,
            state.turn.runtime,
            this.options.approvalMode?.(state.policy) ?? state.policy,
            state.planMode,
            grants.approvals,
          )
        },
      })
      const info = await rpc.initialize(input.signal)
      await authenticateAcp(rpc, launch, input.signal)
      this.options.onInitialize?.(scope, info)
      const native = info.agentCapabilities?.sessionCapabilities
      bridge = await sessionBridge(
        input.mcp,
        Boolean(info.agentCapabilities?.mcpCapabilities?.http),
      )
      const args = {
        cwd: input.cwd,
        mcpServers: bridge.servers,
        ...(this.options.sessionMeta ? { _meta: this.options.sessionMeta } : {}),
      }
      const agent = rpc.agent
      const original = input.nativeSessionId
      let setup: SessionSetup
      let nativeId: string
      if (original) {
        const request = { ...args, sessionId: original }
        if (native?.resume)
          setup = await setupAcpSession(
            rpc,
            this.options.authMethod?.(launch),
            () => agent.request("session/resume", request, requestOptions(input.signal)),
            input.signal,
          )
        else if (info.agentCapabilities?.loadSession)
          setup = await setupAcpSession(
            rpc,
            this.options.authMethod?.(launch),
            () => agent.request("session/load", request, requestOptions(input.signal)),
            input.signal,
          )
        else throw new Error(missingSession)
        nativeId = original
      } else {
        const started = await setupAcpSession(
          rpc,
          this.options.authMethod?.(launch),
          () =>
            agent.request<NewSessionResponse>("session/new", args, requestOptions(input.signal)),
          input.signal,
        )
        setup = started
        nativeId = started.sessionId
      }
      if (!nativeId) throw new Error("ACP returned no native session ID")
      rpc.signal.throwIfAborted()
      const currentMode =
        selectConfig(setup.configOptions ?? [], "mode")?.currentValue ?? setup.modes?.currentModeId
      const state: AcpSession = {
        rpc,
        bridge,
        scope,
        nativeId,
        setup,
        policy,
        invocation,
        fresh: !original,
        canClose: Boolean(native?.close),
        supportsImage: Boolean(info.agentCapabilities?.promptCapabilities?.image),
        liveOnly: Boolean(
          this.options.retainLiveOnly && !native?.resume && !info.agentCapabilities?.loadSession,
        ),
        planMode: input.planMode ?? false,
        normalMode:
          typeof currentMode === "string" && currentMode !== "plan" ? currentMode : undefined,
        release: lifecycle.release ?? (() => undefined),
        translateError: lifecycle.translateError,
      }
      this.options.onSession?.(scope, setup, info)
      active.state = state
      this.sessions.set(id, state)
      this.grants.set(id, grants)
      return buildSessionHandle(id, input, nativeId, policy)
    } catch (error) {
      if (rpc) await this.closeProcess(rpc)
      bridge?.close()
      lifecycle.release?.()
      if (input.nativeSessionId && isMissingAcpSession(error)) throw new Error(missingSession)
      throw lifecycle.translateError?.(error) ?? error
    }
  }

  async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime) {
    const state = this.sessions.get(session.id)
    if (!state) throw new Error(missingSession)
    let finish = () => {}
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const turn: AcpTurn = {
      runtime,
      events: new TurnEvents(runtime),
      done,
      finish,
      prompting: false,
      cancelled: false,
    }
    state.turn = turn
    state.planMode = session.planMode ?? false
    const cancel = () => this.cancel(state, turn)
    runtime.signal.addEventListener("abort", cancel, { once: true })
    try {
      runtime.signal.throwIfAborted()
      if (state.fresh || session.nativeSessionId !== state.nativeId) {
        runtime.emit({ type: "session.started", nativeSessionId: state.nativeId })
        state.fresh = false
      }
      const policyOption = this.options.sessionPolicy?.(state.setup, state.policy)
      if (policyOption) {
        const reply = await state.rpc.agent.request(
          "session/set_config_option",
          {
            sessionId: state.nativeId,
            configId: policyOption.id,
            value: policyOption.value,
          },
          requestOptions(runtime.signal),
        )
        state.setup.configOptions = reply.configOptions
      }
      const normal =
        policyOption?.id === "mode"
          ? policyOption.value
          : (this.options.normalMode?.(state.setup, state.policy) ?? state.normalMode)
      await configureSession(
        state,
        session,
        input,
        runtime.signal,
        normal,
        this.options.effortId,
        this.options.legacyModelEffort,
        this.options.deferredEffort,
      )
      runtime.signal.throwIfAborted()
      turn.prompting = true
      const promptPayload = await buildPromptPayload(input, state.supportsImage)
      const result = await state.rpc.prompt(state.nativeId, promptPayload)
      turn.events.finish()
      if (turn.cancelled || result.stopReason === "cancelled")
        runtime.emit({ type: "run.interrupted" })
      else if (result.stopReason !== "end_turn")
        throw new Error(`ACP Agent stopped: ${result.stopReason}`)
    } catch (error) {
      turn.events.finish()
      if (turn.cancelled || runtime.signal.aborted) runtime.emit({ type: "run.interrupted" })
      else if (isMissingAcpSession(error)) throw new Error(missingSession)
      else throw state.translateError?.(error) ?? error
    } finally {
      runtime.signal.removeEventListener("abort", cancel)
      clearTimeout(turn.timer)
      turn.prompting = false
      try {
        if (!state.liveOnly || state.rpc.signal.aborted) await this.finish(session.id, state)
      } finally {
        state.turn = undefined
        turn.finish()
      }
    }
  }

  private cancel(state: AcpSession, turn: AcpTurn) {
    if (turn.cancelled) return
    turn.cancelled = true
    if (!turn.prompting) {
      void this.closeProcess(state.rpc)
      return
    }
    void state.rpc.agent
      .notify("session/cancel", {
        sessionId: state.nativeId,
        ...(this.options.cancelMeta ? { _meta: this.options.cancelMeta } : {}),
      })
      .catch(() => undefined)
    turn.timer = setTimeout(() => void this.closeProcess(state.rpc), 5_000)
    turn.timer.unref()
  }

  async interrupt(session: AgentSessionHandle) {
    const state = this.sessions.get(session.id)
    if (!state?.turn) return
    this.cancel(state, state.turn)
    await state.turn.done
  }

  async dispose(session: AgentSessionHandle) {
    const state = this.sessions.get(session.id)
    if (state) await this.finish(session.id, state)
    this.grants.delete(session.id)
  }

  private async closeNative(rpc: AcpProcess, id: string, supported: boolean, signal?: AbortSignal) {
    if (supported && !signal?.aborted && !rpc.signal.aborted)
      await rpc.agent
        .request("session/close", { sessionId: id }, requestOptions(signal, 3_000))
        .catch(() => undefined)
  }

  private finish(id: string, state: AcpSession) {
    state.ending ??= (async () => {
      try {
        if (!state.turn?.prompting)
          await this.closeNative(state.rpc, state.nativeId, state.canClose)
        await this.closeProcess(state.rpc)
      } finally {
        state.bridge.close()
        state.release()
        if (this.sessions.get(id) === state) this.sessions.delete(id)
      }
    })()
    return state.ending
  }

  async closeScope(scope: string) {
    this.commands.delete(scope)
    for (const [id, item] of this.grants) if (item.scope === scope) this.grants.delete(id)
    await Promise.all(
      [...this.processes].flatMap(([rpc, owner]) =>
        owner === scope ? [this.closeProcess(rpc)] : [],
      ),
    )
    await Promise.all(
      [...this.sessions].flatMap(([id, state]) =>
        state.scope === scope ? [this.finish(id, state)] : [],
      ),
    )
  }

  async close() {
    this.closed = true
    await Promise.all([...this.processes.keys()].map((rpc) => this.closeProcess(rpc)))
    await Promise.all([...this.sessions].map(([id, state]) => this.finish(id, state)))
    this.commands.clear()
    this.grants.clear()
  }
}
