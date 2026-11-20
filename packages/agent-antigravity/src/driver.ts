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
import { AntigravityAccounts } from "./auth"
import { antigravityConnection } from "./connection"
import { AntigravityInstallation, executableVersion } from "./installation"
import { acpLaunch, instanceProfile } from "./launch"

const signInRequired = "Sign in to this Antigravity instance in Agent settings"
const unsupported = "Update Antigravity CLI to a compatible version"

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
    const auth = await this.accounts.status(scope, settings, command)
    return {
      installed: true,
      version,
      command,
      authenticated: auth.phase === "connected",
      ...(auth.usingCliLogin ? { usingCliLogin: true } : {}),
      account: auth.phase === "connected" ? "Google" : null,
    }
  }

  async listModels(settings: AgentSettingsValues, instance?: AgentInstanceContext) {
    const scope = requireInstance(instance)
    if (this.accounts.busy(scope)) return []
    const auth = await this.accounts.status(scope, settings)
    if (auth.phase !== "connected") return []
    const executable = await this.installation.acquire(settings, scope)
    let cwd: string | undefined
    try {
      cwd = await mkdtemp(join(tmpdir(), "pigcode-agy-models-"))
      const launch = await acpLaunch(
        executable.command,
        settings,
        auth.usingCliLogin ? null : await instanceProfile(scope),
        cwd,
      )
      if (this.accounts.busy(scope)) return []
      return await this.runtime.readCatalog(launch, scope.dataDir)
    } catch (error) {
      if (!isAuthRequired(error)) throw error
      this.accounts.requireSignIn(scope, auth.usingCliLogin)
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
      this.accounts.busy(scope) ||
      (await this.accounts.status(scope, settings)).phase !== "connected"
    )
      return []
    const list = this.runtime.readCommands(scope.dataDir, cwd)
    if (list) return list
    await this.listModels(settings, scope)
    return this.runtime.readCommands(scope.dataDir, cwd) ?? []
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionHandle> {
    const instance = requireInstance(input.instance)
    if (this.accounts.busy(instance)) throw new Error("Antigravity account setup is in progress")
    const settings = input.settings ?? {}
    const auth = await this.accounts.status(instance, settings)
    if (auth.phase !== "connected") throw new Error(signInRequired)
    input.signal?.throwIfAborted()
    const executable = await this.installation.acquire(settings, instance)
    try {
      const launch = await acpLaunch(
        executable.command,
        settings,
        auth.usingCliLogin ? null : await instanceProfile(instance),
        input.cwd,
      )
      if (this.accounts.busy(instance)) throw new Error("Antigravity account setup is in progress")
      if (input.mcp) launch.args.push("--process-per-session")
      return await this.runtime.createSession(input, launch, instance.dataDir, {
        release: executable.release,
        translateError: (error) => {
          if (!isAuthRequired(error)) return error
          this.accounts.requireSignIn(instance, auth.usingCliLogin)
          return new Error(signInRequired)
        },
      })
    } catch (error) {
      executable.release()
      throw error
    }
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

  isSessionNotFound(message: string): boolean {
    return message === missingSession
  }

  async close() {
    await this.accounts.dispose()
    await this.runtime.close()
  }
}
