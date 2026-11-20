import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  AcpRuntime,
  isAuthRequired,
  missingSession,
  requestOptions,
  supportsPlan,
  type AcpLaunch,
  type InitializeResponse,
} from "@pigcode/acp-runtime"
import type {
  AgentAuthAction,
  AgentAuthState,
  AgentFeatures,
  AgentStatus,
} from "@pigcode/contracts"
import type {
  AgentDriver,
  AgentInstanceContext,
  AgentRuntime,
  AgentSessionHandle,
  AgentSettingsValues,
  CreateSessionInput,
  UserInput,
} from "@pigcode/plugin-sdk"
import { RegistryRuntimes } from "./registry"

interface AgentInfo {
  info?: InitializeResponse
  authenticated?: boolean
  plan?: boolean
}

interface Login {
  state: AgentAuthState
  controller: AbortController
  done: Promise<void>
}

function requireInstance(scope: AgentInstanceContext | undefined) {
  if (!scope) throw new Error("ACP needs an Agent instance")
  return scope
}

function authState(phase: AgentAuthState["phase"], error: string | null = null): AgentAuthState {
  return { phase, error, flowId: null, authorizationUrl: null, expiresAt: null }
}

export class AcpDriver implements AgentDriver {
  readonly id = "acp"
  readonly displayName = "ACP"
  readonly executionModes = { plan: true }
  readonly modelSwitch = "reuse"
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

  private readonly registry: RegistryRuntimes
  private readonly observed = new Map<string, AgentInfo>()
  private readonly logins = new Map<string, Login>()
  private readonly runtime = new AcpRuntime({
    id: this.id,
    name: "ACP Agent",
    retainLiveOnly: true,
    onSession: (scope, setup, info) =>
      this.observed.set(scope, {
        ...this.observed.get(scope),
        info,
        authenticated: true,
        ...(setup.modes || setup.configOptions ? { plan: supportsPlan(setup) } : {}),
      }),
  })

  constructor(fetchRegistry?: typeof fetch) {
    this.registry = new RegistryRuntimes(fetchRegistry)
  }

  acpRegistry() {
    return this.registry.list()
  }

  modesForInstance(instance: AgentInstanceContext) {
    const plan = this.observed.get(instance.dataDir)?.plan
    return plan === undefined ? undefined : { plan }
  }

  prepareCliUpdate(settings: AgentSettingsValues, scope?: AgentInstanceContext) {
    return this.registry.prepare(settings, requireInstance(scope))
  }

  removeManagedCli(
    instance: AgentInstanceContext,
    configured: readonly AgentSettingsValues[],
    settings?: AgentSettingsValues,
  ) {
    return this.registry.remove(settings ?? {}, instance, configured)
  }

  private async temporary<T>(
    settings: AgentSettingsValues,
    scope: AgentInstanceContext,
    action: (launch: AcpLaunch) => Promise<T>,
  ): Promise<T | null> {
    const cwd = await mkdtemp(join(tmpdir(), "pigcode-acp-"))
    try {
      const program = await this.registry.launch(settings, scope, cwd)
      if (!program) return null
      const release = this.registry.lease(program.directory)
      try {
        return await action(program.launch)
      } finally {
        release()
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }

  async detect(
    settings: AgentSettingsValues,
    instance?: AgentInstanceContext,
  ): Promise<AgentStatus> {
    const scope = requireInstance(instance)
    let command: string | undefined
    try {
      const info = await this.temporary(settings, scope, async (launch) => {
        command = launch.command
        const rpc = this.runtime.open(launch, scope.dataDir)
        try {
          return await rpc.initialize()
        } finally {
          await this.runtime.closeProcess(rpc)
        }
      })
      if (!info) return { installed: false, version: null, authenticated: null }
      const previous = this.observed.get(scope.dataDir)
      this.observed.set(scope.dataDir, { ...previous, info })
      return {
        installed: true,
        command,
        version: info.agentInfo?.version ?? null,
        authenticated: previous?.authenticated ?? null,
      }
    } catch (error) {
      return {
        installed: false,
        command,
        version: null,
        authenticated: null,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async listModels(settings: AgentSettingsValues, instance?: AgentInstanceContext) {
    const scope = requireInstance(instance)
    if (this.logins.get(scope.dataDir)?.state.phase === "starting") return []
    try {
      return (
        (await this.temporary(settings, scope, (launch) =>
          this.runtime.readCatalog(launch, scope.dataDir),
        )) ?? []
      )
    } catch (error) {
      if (!isAuthRequired(error)) throw error
      this.requireLogin(scope)
      return []
    }
  }

  async listCommands(
    settings: AgentSettingsValues,
    cwd: string | null,
    instance?: AgentInstanceContext,
  ) {
    const scope = requireInstance(instance)
    const current = this.runtime.readCommands(scope.dataDir, cwd)
    if (current) return current
    await this.listModels(settings, scope)
    return this.runtime.readCommands(scope.dataDir, cwd) ?? []
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionHandle> {
    const scope = requireInstance(input.instance)
    if (this.logins.get(scope.dataDir)?.state.phase === "starting")
      throw new Error("ACP sign-in is in progress")
    const program = await this.registry.launch(input.settings ?? {}, scope, input.cwd)
    if (!program)
      throw new Error("Set a local ACP command or install its Registry runtime in Agent settings")
    return this.runtime.createSession(input, program.launch, scope.dataDir, {
      release: this.registry.lease(program.directory),
      translateError: (error) => {
        if (!isAuthRequired(error)) return error
        this.requireLogin(scope)
        return new Error("Sign in to this ACP Agent before starting a session")
      },
    })
  }

  send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime) {
    return this.runtime.send(session, input, runtime)
  }
  interrupt(session: AgentSessionHandle) {
    return this.runtime.interrupt(session)
  }
  dispose(session: AgentSessionHandle) {
    return this.runtime.dispose(session)
  }
  isSessionNotFound(message: string) {
    return message === missingSession
  }

  readonly accountSetup = {
    auth: (request: AgentAuthAction, settings: AgentSettingsValues, scope: AgentInstanceContext) =>
      this.auth(request, settings, scope),
    close: (scope: AgentInstanceContext) => this.closeInstance(scope),
  }

  private requireLogin(scope: AgentInstanceContext) {
    if (this.logins.get(scope.dataDir)?.state.phase === "connected")
      this.logins.delete(scope.dataDir)
    this.observed.set(scope.dataDir, { ...this.observed.get(scope.dataDir), authenticated: false })
    scope.invalidate()
  }

  private async auth(
    request: AgentAuthAction,
    settings: AgentSettingsValues,
    scope: AgentInstanceContext,
  ): Promise<AgentAuthState> {
    const key = scope.dataDir
    const existing = this.logins.get(key)
    if (request.action === "status") {
      if (existing?.state.phase === "starting") return this.withMethods(scope, existing.state)
      const state = this.observed.get(key)?.authenticated
        ? authState("connected")
        : (existing?.state ?? authState("signed-out"))
      return this.withMethods(scope, state)
    }
    if (request.action === "cancel") {
      if (existing?.state.flowId !== request.flowId)
        throw new Error("ACP sign-in is no longer active")
      existing.controller.abort()
      await existing.done
      return this.withMethods(scope, existing.state)
    }
    if (request.action === "submit")
      throw new Error("This ACP authentication method is handled by the Agent")
    if (request.action === "logout") {
      await this.closeInstance(scope)
      await this.temporary(settings, scope, async (launch) => {
        const rpc = this.runtime.open(launch, key)
        try {
          const info = await rpc.initialize()
          if (!info.agentCapabilities?.auth?.logout)
            throw new Error("This ACP Agent manages sign-out in its CLI")
          await rpc.agent.request("logout", {}, requestOptions())
          this.observed.set(key, { info, authenticated: false })
        } finally {
          await this.runtime.closeProcess(rpc)
        }
      })
      scope.invalidate()
      return this.withMethods(scope, authState("signed-out"))
    }
    if (existing?.state.phase === "starting") return this.withMethods(scope, existing.state)
    const controller = new AbortController()
    const state = {
      ...authState("starting"),
      flowId: randomUUID(),
      expiresAt: Date.now() + 180_000,
    }
    const login: Login = { state, controller, done: Promise.resolve() }
    this.logins.set(key, login)
    login.done = this.signIn(login, request.methodId, settings, scope)
    return this.withMethods(scope, state)
  }

  private withMethods(scope: AgentInstanceContext, state: AgentAuthState): AgentAuthState {
    const info = this.observed.get(scope.dataDir)?.info
    const methods = (info?.authMethods ?? []).filter(
      (method) => !("type" in method) || method.type !== "terminal",
    )
    return {
      ...state,
      methods: methods.map(({ id, name }) => ({ id, name })),
      canLogout: Boolean(info?.agentCapabilities?.auth?.logout),
    }
  }

  private async signIn(
    login: Login,
    methodId: string | undefined,
    settings: AgentSettingsValues,
    scope: AgentInstanceContext,
  ) {
    const signal = AbortSignal.any([login.controller.signal, AbortSignal.timeout(180_000)])
    try {
      await this.runtime.closeScope(scope.dataDir)
      const confirmed = await this.temporary(settings, scope, async (launch) => {
        const rpc = this.runtime.open(launch, scope.dataDir)
        try {
          const info = await rpc.initialize(signal)
          const methods = (info.authMethods ?? []).filter(
            (method) => !("type" in method) || method.type !== "terminal",
          )
          const method = methodId ? methods.find(({ id }) => id === methodId) : methods[0]
          if (!method) throw new Error("Sign in using the Agent's own CLI, then refresh its models")
          await rpc.agent.request(
            "authenticate",
            { methodId: method.id },
            requestOptions(signal, 180_000),
          )
          return true
        } finally {
          await this.runtime.closeProcess(rpc)
        }
      })
      if (!confirmed) throw new Error("Configure or install the ACP command first")
      await this.temporary(settings, scope, (launch) =>
        this.runtime.readCatalog(launch, scope.dataDir, signal),
      )
      login.state = authState("connected")
    } catch (error) {
      login.state = login.controller.signal.aborted
        ? authState("cancelled")
        : authState("failed", error instanceof Error ? error.message : "ACP sign-in failed")
    } finally {
      scope.invalidate()
    }
  }

  private async closeInstance(scope: AgentInstanceContext) {
    const login = this.logins.get(scope.dataDir)
    login?.controller.abort()
    await login?.done
    this.logins.delete(scope.dataDir)
    this.observed.delete(scope.dataDir)
    await this.runtime.closeScope(scope.dataDir)
  }

  async close() {
    for (const login of this.logins.values()) login.controller.abort()
    await Promise.all([...this.logins.values()].map(({ done }) => done))
    this.logins.clear()
    this.observed.clear()
    await this.runtime.close()
  }
}
