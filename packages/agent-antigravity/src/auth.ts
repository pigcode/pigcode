import { authConfig, rejectedCredential } from "./auth-config"
import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentAuthAction, AgentAuthState } from "@pigcode/contracts"
import {
  settingEnvironment,
  type AgentInstanceContext,
  type AgentSettingsValues,
} from "@pigcode/plugin-sdk"
import { openAcp, requestOptions } from "./connection"
import { authenticateBrowser, enterpriseRuntimeRequired } from "./enterprise-auth"
import {
  authenticateCli,
  googleAuthorization,
  responseCode,
  type PresentAuthorization,
} from "./google-oauth"
import type { AntigravityInstallation } from "./installation"
import {
  acpLaunch,
  activateProfile,
  hasCredential,
  hasCliLogin,
  instanceProfile,
  newProfile,
  type AgyLaunch,
  type AgyProfile,
} from "./launch"

const signInTimeout = 5 * 60_000
const inProgress = (state?: AgentAuthState) =>
  state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying"
const credentialMarker = (instance: AgentInstanceContext, key: string) =>
  join(instance.dataDir, "credentials", key)

function snapshot(phase: AgentAuthState["phase"], error: string | null = null): AgentAuthState {
  return { phase, authorizationUrl: null, flowId: null, expiresAt: null, error }
}

interface Flow {
  configKey: string
  state: AgentAuthState
  controller: AbortController
  complete: Promise<void>
  submit?: (code: string) => void | Promise<void>
}

export class AntigravityAccounts {
  private readonly flows = new Map<string, Flow>()
  private readonly loggingOut = new Set<string>()
  private readonly expired = new Set<string>()
  private readonly rejected = new Map<string, string>()
  private readonly cliChecks = new Map<
    string,
    { key: string; until: number; result: Promise<boolean> }
  >()
  private closed = false

  constructor(
    private readonly installation: AntigravityInstallation,
    private readonly verify: (
      launch: AgyLaunch,
      instance: AgentInstanceContext,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly stopSessions: (instance: AgentInstanceContext) => Promise<void>,
  ) {}

  async status(
    instance: AgentInstanceContext,
    settings: AgentSettingsValues,
    executable?: string,
  ): Promise<AgentAuthState> {
    const config = authConfig(settings)
    if (config.error) return { ...snapshot("failed", config.error), canLogout: false }
    const flow = this.flows.get(instance.dataDir)
    const state = flow?.configKey === config.credentialKey ? flow.state : undefined
    if (state && inProgress(state)) return state
    if (!config.browser) {
      const key = instance.dataDir + "/" + config.credentialKey
      const rejection = this.rejected.get(key)
      if (rejection) {
        return {
          ...snapshot("failed", rejection),
          methods: [{ id: "verify", name: config.label }],
          canLogout: false,
        }
      }
      const marker = await readFile(credentialMarker(instance, config.credentialKey), "utf8").catch(
        () => null,
      )
      if (marker === "rejected") {
        return {
          ...snapshot("failed", rejectedCredential),
          methods: [{ id: "verify", name: config.label }],
          canLogout: false,
        }
      }
      if (
        !this.expired.has(key) &&
        ["configured", "verified", "used"].some((value) => value === marker)
      )
        return {
          ...snapshot("connected"),
          canLogout: false,
          credentialsConfigured: marker !== "used",
        }
      return {
        ...(state?.phase === "failed" || state?.phase === "cancelled"
          ? state
          : snapshot("signed-out")),
        methods: [{ id: "verify", name: config.label }],
        canLogout: false,
      }
    }
    const profile = await instanceProfile(instance, settings)
    if (
      !this.expired.has(instance.dataDir + "/" + config.credentialKey) &&
      (await hasCredential(profile))
    )
      return snapshot("connected")
    if (
      config.method === "oauth-personal" &&
      instance.instanceId === "antigravity" &&
      profile.directory === join(instance.dataDir, "initial") &&
      !this.expired.has(instance.dataDir + "/" + config.credentialKey)
    ) {
      const command = executable ?? (await this.installation.resolve(settings, instance))
      if (command && (await this.checkCli(instance, settings, command)))
        return { ...snapshot("connected", state?.error), usingCliLogin: true }
    }
    return state?.phase === "failed" || state?.phase === "cancelled"
      ? state
      : snapshot("signed-out")
  }

  async markCredentials(
    instance: AgentInstanceContext,
    settings: AgentSettingsValues,
    outcome: "configured" | "used",
  ) {
    const config = authConfig(settings)
    if (config.browser) return
    const key = instance.dataDir + "/" + config.credentialKey
    if (outcome === "configured" && (this.expired.has(key) || this.rejected.has(key))) return
    const marker = credentialMarker(instance, config.credentialKey)
    if (outcome === "configured") {
      await mkdir(join(instance.dataDir, "credentials"), { recursive: true, mode: 0o700 })
      await writeFile(marker, outcome, { mode: 0o600, flag: "wx" }).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error
        },
      )
      return
    }
    await mkdir(join(instance.dataDir, "credentials"), { recursive: true, mode: 0o700 })
    await writeFile(marker, outcome, { mode: 0o600 })
    this.expired.delete(key)
    this.rejected.delete(key)
    instance.invalidate()
  }

  async rejectCredential(instance: AgentInstanceContext, settings: AgentSettingsValues) {
    this.requireSignIn(instance, settings)
    const key = authConfig(settings).credentialKey
    this.rejected.set(instance.dataDir + "/" + key, rejectedCredential)
    await mkdir(join(instance.dataDir, "credentials"), { recursive: true, mode: 0o700 })
    await writeFile(credentialMarker(instance, key), "rejected", { mode: 0o600 })
  }
  private checkCli(instance: AgentInstanceContext, settings: AgentSettingsValues, command: string) {
    const key = JSON.stringify([command, settingEnvironment(settings)])
    const cached = this.cliChecks.get(instance.dataDir)
    if (cached?.key === key && Date.now() < cached.until) return cached.result
    const result = hasCliLogin(command, settings)
    this.cliChecks.set(instance.dataDir, { key, until: Date.now() + 10_000, result })
    return result
  }

  busy(instance: AgentInstanceContext, settings: AgentSettingsValues): boolean {
    const flow = this.flows.get(instance.dataDir)
    return (
      this.closed ||
      this.loggingOut.has(instance.dataDir) ||
      (flow?.configKey === authConfig(settings).credentialKey && inProgress(flow.state))
    )
  }

  requireSignIn(
    instance: AgentInstanceContext,
    settings: AgentSettingsValues,
    usingCliLogin = false,
  ): void {
    const config = authConfig(settings)
    if (usingCliLogin) {
      const cached = this.cliChecks.get(instance.dataDir)
      if (cached)
        this.cliChecks.set(instance.dataDir, { ...cached, result: Promise.resolve(false) })
    } else {
      this.expired.add(instance.dataDir + "/" + config.credentialKey)
      if (!config.browser) rmSync(credentialMarker(instance, config.credentialKey), { force: true })
    }
    const flow = this.flows.get(instance.dataDir)
    if (flow?.configKey === config.credentialKey && !inProgress(flow.state))
      this.flows.delete(instance.dataDir)
    instance.invalidate()
  }

  async auth(
    request: AgentAuthAction,
    settings: AgentSettingsValues,
    instance: AgentInstanceContext,
  ): Promise<AgentAuthState> {
    const key = instance.dataDir
    if (request.action === "status") return this.status(instance, settings)
    const config = authConfig(settings)
    if (config.error) throw new Error(config.error)
    if (request.action === "terminal") throw new Error("Antigravity uses the Google sign-in flow")
    if (this.closed || this.loggingOut.has(key))
      throw new Error("Antigravity account operation in progress")
    if (request.action === "logout") {
      if (!config.browser)
        throw new Error(
          "Remove the API key or change the authentication settings for this instance",
        )
      if ((await this.status(instance, settings)).usingCliLogin)
        throw new Error("This instance uses the login managed by Antigravity CLI")
      this.loggingOut.add(key)
      try {
        await this.close(instance)
        await this.logout(settings, instance)
        this.expired.delete(key + "/" + config.credentialKey)
        return snapshot("signed-out")
      } finally {
        this.loggingOut.delete(key)
        instance.invalidate()
      }
    }
    const existing = this.flows.get(key)
    if (request.action === "start") {
      if (existing && inProgress(existing.state)) {
        if (existing.configKey === config.credentialKey) return existing.state
        existing.controller.abort()
        await existing.complete
      }
      const status = await this.status(instance, settings)
      if (status.phase === "connected" && !status.usingCliLogin) return status
      if (this.closed || this.loggingOut.has(key))
        throw new Error("Antigravity account operation in progress")
      const current = this.flows.get(key)
      if (current && inProgress(current.state)) return current.state
      const flow: Flow = {
        configKey: config.credentialKey,
        state: {
          ...snapshot("starting"),
          flowId: randomUUID(),
          expiresAt: Date.now() + signInTimeout,
        },
        controller: new AbortController(),
        complete: Promise.resolve(),
      }
      this.flows.set(key, flow)
      instance.invalidate()
      flow.complete = this.start(flow, settings, instance)
      return flow.state
    }
    if (
      !existing ||
      existing.configKey !== config.credentialKey ||
      existing.state.flowId !== request.flowId ||
      !inProgress(existing.state)
    )
      throw new Error("This Antigravity sign-in attempt is no longer active")
    if (request.action === "cancel") {
      existing.controller.abort()
      await existing.complete
      return existing.state
    }
    if (existing.state.phase !== "waiting" || !existing.state.authorizationUrl || !existing.submit)
      throw new Error("Antigravity is not waiting for a Google authorization code")
    const code = responseCode(request.response, existing.state.authorizationUrl)
    const before = existing.state
    existing.state = { ...before, phase: "verifying", authorizationUrl: null }
    try {
      await existing.submit(code)
    } catch (error) {
      if (existing.state.phase === "verifying") existing.state = before
      throw error
    }
    return existing.state
  }

  private async start(
    flow: Flow,
    settings: AgentSettingsValues,
    instance: AgentInstanceContext,
  ): Promise<void> {
    const deadline = AbortSignal.timeout(signInTimeout)
    const signal = AbortSignal.any([flow.controller.signal, deadline])
    const config = authConfig(settings)
    const profile = newProfile(instance)
    let activated = false
    try {
      await this.stopSessions(instance)
      const previous = await instanceProfile(instance, settings)
      if (!config.browser) {
        const key = instance.dataDir + "/" + config.credentialKey
        const knownRejection =
          this.rejected.get(key) ||
          ((await readFile(credentialMarker(instance, config.credentialKey), "utf8").catch(
            () => null,
          )) === "rejected"
            ? rejectedCredential
            : null)
        if (knownRejection) {
          flow.state = { ...snapshot("failed", knownRejection), canLogout: false }
          return
        }
        flow.state = { ...flow.state, phase: "verifying" }
        await this.withLaunch(
          settings,
          instance,
          previous,
          (launch) => this.verify(launch, instance, signal),
          config.method === "agent-platform" && config.key ? signal : undefined,
        )
        signal.throwIfAborted()
        if (!this.rejected.has(key)) this.expired.delete(key)
        await this.markCredentials(instance, settings, "configured")
        flow.state = { ...snapshot("connected"), canLogout: false, credentialsConfigured: true }
        return
      }
      await this.withLaunch(
        settings,
        instance,
        profile,
        async (launch) => {
          const standalone = Boolean(launch.env.ANTIGRAVITY_HARNESS_PATH)
          const present: PresentAuthorization = (link, submit) => {
            const authorizationUrl = googleAuthorization(link, standalone).href
            if (flow.state.phase !== "starting")
              throw new Error("Antigravity sent multiple sign-in links")
            flow.submit = submit
            flow.state = { ...flow.state, phase: "waiting", authorizationUrl }
          }
          if (standalone) {
            const method = config.method === "oauth-business" ? "oauth-business" : "oauth-personal"
            await authenticateBrowser(launch, method, signal, present)
          } else {
            if (config.method === "oauth-business") throw new Error(enterpriseRuntimeRequired)
            await authenticateCli(launch, signal, present)
          }
          signal.throwIfAborted()
          flow.state = { ...flow.state, phase: "verifying", authorizationUrl: null }
          await this.verify(launch, instance, signal)
        },
        config.method === "oauth-business" ? signal : undefined,
      )
      if (!(await hasCredential(profile)))
        throw new Error("Antigravity did not save this instance's sign-in")
      await activateProfile(instance, profile, signal, settings)
      activated = true
      this.expired.delete(instance.dataDir + "/" + authConfig(settings).credentialKey)
      flow.state = snapshot("connected")
      await rm(previous.tokenPath, { force: true }).catch(() => undefined)
    } catch (error) {
      flow.state = flow.controller.signal.aborted
        ? snapshot("cancelled")
        : snapshot(
            "failed",
            deadline.aborted
              ? "Google sign-in expired"
              : error instanceof Error
                ? error.message
                : "Google sign-in failed",
          )
    } finally {
      delete flow.submit
      if (!activated)
        await rm(profile.directory, { recursive: true, force: true }).catch(() => undefined)
      instance.invalidate()
    }
  }

  private async logout(
    settings: AgentSettingsValues,
    instance: AgentInstanceContext,
  ): Promise<void> {
    const profile = await instanceProfile(instance, settings)
    if (!(await hasCredential(profile))) return
    await this.withLaunch(settings, instance, profile, async (launch) => {
      const process = openAcp(launch)
      try {
        await process.initialize()
        await process.agent.request("logout", {}, requestOptions())
        if (await hasCredential(profile))
          throw new Error("Antigravity did not clear the Google sign-in")
      } finally {
        await process.close()
      }
    })
  }

  private async withLaunch<T>(
    settings: AgentSettingsValues,
    instance: AgentInstanceContext,
    profile: AgyProfile,
    action: (launch: AgyLaunch) => Promise<T>,
    prepareStandalone?: AbortSignal,
  ): Promise<T> {
    const executable = prepareStandalone
      ? await this.installation.prepareEnterprise(settings, instance, prepareStandalone)
      : await this.installation.acquire(settings, instance)
    let cwd: string | undefined
    try {
      cwd = await mkdtemp(join(tmpdir(), "pigcode-agy-auth-"))
      return await action(await acpLaunch(executable.command, settings, profile, cwd))
    } finally {
      executable.release()
      if (cwd) await rm(cwd, { recursive: true, force: true })
    }
  }

  async close(instance: AgentInstanceContext): Promise<void> {
    const flow = this.flows.get(instance.dataDir)
    flow?.controller.abort()
    await flow?.complete
    this.flows.delete(instance.dataDir)
    this.cliChecks.delete(instance.dataDir)
    await this.stopSessions(instance)
  }

  async dispose(): Promise<void> {
    this.closed = true
    for (const flow of this.flows.values()) flow.controller.abort()
    await Promise.all([...this.flows.values()].map((flow) => flow.complete))
    this.flows.clear()
    this.cliChecks.clear()
  }
}
