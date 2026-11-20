import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpRuntime, isAuthRequired, missingSession } from "@pigcode/acp-runtime"
import type { AgentFeatures, AgentStatus } from "@pigcode/contracts"
import type {
  AgentDriver,
  AgentInstanceContext,
  AgentRuntime,
  AgentSessionHandle,
  AgentSettingsValues,
  CreateSessionInput,
  UserInput,
} from "@pigcode/plugin-sdk"
import { authConfig, rejectedCredential } from "./auth-config"
import { AntigravityAccounts } from "./auth"
import { antigravityConnection } from "./connection"
import { enterpriseRuntimeRequired } from "./enterprise-auth"
import { AntigravityInstallation, executableVersion } from "./installation"
import { acpLaunch, configuredBinary, instanceProfile, standaloneHarness } from "./launch"

const signInRequired = "Sign in to this Antigravity instance in Agent settings"
const unsupported = "Update Antigravity CLI to a compatible version"

/** agy reports rejected model credentials in an assistant error chunk even when the turn stops normally. */
function isCredentialErrorChunk(text: string) {
  return (
    isExecutorErrorChunk(text) &&
    /(?:api key not valid|invalid api key|API_KEY_INVALID|UNAUTHENTICATED|invalid_grant|invalid authentication credentials)/i.test(
      text,
    )
  )
}

function isExecutorErrorChunk(text: string) {
  return /^\s*⚠\s*agent executor error:/u.test(text)
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
  private readonly configuredSessions = new Map<
    string,
    {
      instance: AgentInstanceContext
      settings: AgentSettingsValues
    }
  >()
  private readonly runtime = new AcpRuntime({
    id: this.id,
    ...antigravityConnection,
    probeModelEfforts: true,
    normalMode: (setup, permission) =>
      permission === "auto" && setup.modes?.availableModes.some(({ id }) => id === "auto")
        ? "auto"
        : "default",
  })

  constructor(fetchRelease?: typeof fetch) {
    this.installation = new AntigravityInstallation(fetchRelease)
    this.accounts = new AntigravityAccounts(
      this.installation,
      async (launch, instance, signal) => {
        await this.runtime.readCatalog(launch, instance.dataDir, signal)
      },
      (instance) => this.runtime.closeScope(instance.dataDir),
    )
  }

  readonly accountSetup = {
    auth: (...args: Parameters<AntigravityAccounts["auth"]>) => this.accounts.auth(...args),
    close: (instance: AgentInstanceContext) => this.accounts.close(instance),
  }

  prepareCliUpdate(settings: AgentSettingsValues, instance?: AgentInstanceContext) {
    return this.installation.prepare(settings, requireInstance(instance))
  }

  removeManagedCli(
    instance: AgentInstanceContext,
    configured: readonly AgentSettingsValues[],
    settings?: AgentSettingsValues,
  ) {
    return this.installation.remove(instance, configured, settings)
  }

  async detect(
    settings: AgentSettingsValues,
    instance?: AgentInstanceContext,
  ): Promise<AgentStatus> {
    const scope = requireInstance(instance)
    const command = await this.installation.resolve(settings, scope)
    const version = command ? await executableVersion(command, settings) : null
    if (!version) return { installed: false, version, authenticated: null, command }
    const standalone = command ? Boolean(await standaloneHarness(command)) : false
    const [major = 0, minor = 0] = version.split(".").map(Number)
    if (!standalone && (major < 1 || (major === 1 && minor < 5)))
      return { installed: true, version, command, authenticated: false, error: unsupported }
    const config = authConfig(settings)
    if (config.error)
      return { installed: true, version, command, authenticated: false, error: config.error }
    if (config.method === "oauth-business" && configuredBinary(settings) && !standalone)
      return {
        installed: true,
        version,
        command,
        authenticated: false,
        error: enterpriseRuntimeRequired,
      }
    const auth = await this.accounts.status(scope, settings, command)
    return {
      installed: true,
      version,
      command,
      authenticated: auth.credentialsConfigured ? null : auth.phase === "connected",
      ...(auth.credentialsConfigured ? { credentialsConfigured: true } : {}),
      ...(auth.usingCliLogin ? { usingCliLogin: true } : {}),
      account: auth.phase === "connected" ? config.label : null,
      ...(auth.error ? { error: auth.error } : {}),
    }
  }

  async listModels(settings: AgentSettingsValues, instance?: AgentInstanceContext) {
    const scope = requireInstance(instance)
    if (this.accounts.busy(scope, settings)) return []
    const auth = await this.accounts.status(scope, settings)
    if (auth.phase !== "connected" && (authConfig(settings).browser || authConfig(settings).error))
      return []
    const executable = await this.installation.acquire(settings, scope)
    let cwd: string | undefined
    try {
      cwd = await mkdtemp(join(tmpdir(), "pigcode-agy-models-"))
      const launch = await acpLaunch(
        executable.command,
        settings,
        auth.usingCliLogin ? null : await instanceProfile(scope, settings),
        cwd,
      )
      if (this.accounts.busy(scope, settings)) return []
      const models = await this.runtime.readCatalog(launch, scope.dataDir)
      await this.accounts.markCredentials(scope, settings, "configured")
      return models
    } catch (error) {
      if (!isAuthRequired(error)) throw error
      this.accounts.requireSignIn(scope, settings, auth.usingCliLogin)
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
    if (
      this.accounts.busy(scope, settings) ||
      (authConfig(settings).browser &&
        (await this.accounts.status(scope, settings)).phase !== "connected")
    )
      return []
    const list = this.runtime.readCommands(scope.dataDir, cwd)
    if (list) return list
    await this.listModels(settings, scope)
    return this.runtime.readCommands(scope.dataDir, cwd) ?? []
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionHandle> {
    const instance = requireInstance(input.instance)
    const settings = input.settings ?? {}
    if (this.accounts.busy(instance, settings))
      throw new Error("Antigravity account setup is in progress")
    const auth = await this.accounts.status(instance, settings)
    const config = authConfig(settings)
    if (config.error) throw new Error(config.error)
    if (config.browser && auth.phase !== "connected") throw new Error(signInRequired)
    input.signal?.throwIfAborted()
    const executable = await this.installation.acquire(settings, instance)
    try {
      const launch = await acpLaunch(
        executable.command,
        settings,
        auth.usingCliLogin ? null : await instanceProfile(instance, settings),
        input.cwd,
      )
      if (this.accounts.busy(instance, settings))
        throw new Error("Antigravity account setup is in progress")
      // agy 的多进程开关只属于 CLI 包装器；独立 ACP 运行时按其握手支持 MCP。
      if (input.mcp && !launch.env.ANTIGRAVITY_HARNESS_PATH)
        launch.args.push("--process-per-session")
      const session = await this.runtime.createSession(input, launch, instance.dataDir, {
        release: executable.release,
        translateError: (error) => {
          if (!isAuthRequired(error)) return error
          this.accounts.requireSignIn(instance, settings, auth.usingCliLogin)
          return new Error(signInRequired)
        },
      })
      if (!config.browser) this.configuredSessions.set(session.id, { instance, settings })
      return session
    } catch (error) {
      executable.release()
      throw error
    }
  }

  async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime) {
    const configured = this.configuredSessions.get(session.id)
    if (!configured) return this.runtime.send(session, input, runtime)
    let rejected = false
    let replied = false
    let interrupted = false
    try {
      await this.runtime.send(session, input, {
        ...runtime,
        emit(event) {
          if (
            (event.type === "message.delta" || event.type === "message.completed") &&
            isCredentialErrorChunk(event.text)
          ) {
            rejected = true
            return
          }
          if (event.type === "message.completed") {
            if (event.text.trim() && !isExecutorErrorChunk(event.text)) replied = true
          }
          if (event.type === "run.interrupted") interrupted = true
          runtime.emit(event)
        },
      })
      if (runtime.signal.aborted || interrupted) return
      if (rejected) {
        await this.accounts.rejectCredential(configured.instance, configured.settings)
        throw new Error(rejectedCredential)
      }
      // Model catalogue and session creation can succeed with an invalid key.
      if (replied)
        await this.accounts.markCredentials(configured.instance, configured.settings, "used")
    } finally {
      this.configuredSessions.delete(session.id)
    }
  }

  interrupt(session: AgentSessionHandle) {
    return this.runtime.interrupt(session)
  }

  dispose(session: AgentSessionHandle) {
    this.configuredSessions.delete(session.id)
    return this.runtime.dispose(session)
  }

  isSessionNotFound(message: string): boolean {
    return message === missingSession
  }

  async close() {
    await this.accounts.dispose()
    await this.runtime.close()
    this.configuredSessions.clear()
  }
}
