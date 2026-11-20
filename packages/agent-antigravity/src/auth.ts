import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import type { AgentAuthAction, AgentAuthState } from "@pigcode/contracts"
import {
  settingEnvironment,
  type AgentInstanceContext,
  type AgentSettingsValues,
} from "@pigcode/plugin-sdk"
import { ownProcessTree } from "@pigcode/plugin-sdk/node"
import { openAcp, requestOptions } from "./connection"
import type { AntigravityInstallation } from "./installation"
import {
  acpLaunch,
  activateProfile,
  hasCredential,
  hasCliLogin,
  instanceProfile,
  newProfile,
  spawnAgy,
  type AgyLaunch,
  type AgyProfile,
} from "./launch"

const signInTimeout = 5 * 60_000
const callbackUrl = "https://antigravity.google/oauth-callback"
const inProgress = (state?: AgentAuthState) =>
  state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying"

function snapshot(phase: AgentAuthState["phase"], error: string | null = null): AgentAuthState {
  return { phase, authorizationUrl: null, flowId: null, expiresAt: null, error }
}

interface Flow {
  state: AgentAuthState
  controller: AbortController
  complete: Promise<void>
  submit?: (code: string) => void
}

function googleAuthorization(line: string): URL {
  const url = new URL(line)
  if (
    line.length > 16_384 ||
    url.origin !== "https://accounts.google.com" ||
    url.username ||
    url.password ||
    !["/o/oauth2/auth", "/o/oauth2/v2/auth"].includes(url.pathname) ||
    url.searchParams.get("response_type") !== "code" ||
    url.searchParams.get("redirect_uri") !== callbackUrl ||
    url.searchParams.getAll("state").length !== 1 ||
    !url.searchParams.get("state")
  )
    throw new Error("Antigravity returned an invalid Google authorization link")
  return url
}

function responseCode(response: string, authorization: string): string {
  const value = response.trim()
  if (/^[\w./~-]{1,2048}$/.test(value)) return value
  const url = URL.parse(value)
  const pending = new URL(authorization)
  const code = url?.searchParams.get("code")
  if (
    !url ||
    /[\r\n]/.test(value) ||
    url.username ||
    url.password ||
    url.origin + url.pathname !== callbackUrl ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== pending.searchParams.get("state") ||
    url.searchParams.getAll("code").length !== 1 ||
    !code ||
    !/^[\w./~-]{1,2048}$/.test(code)
  )
    throw new Error("Paste the authorization code from this Google sign-in attempt")
  return code
}

async function authenticateCli(launch: AgyLaunch, flow: Flow, signal: AbortSignal): Promise<void> {
  // 与 T3 Code 一样让 --login 打印链接，由桌面设置页决定何时打开系统浏览器。
  for (const key of Object.keys(launch.env)) {
    if (["DISPLAY", "WAYLAND_DISPLAY"].includes(key.toUpperCase())) delete launch.env[key]
  }
  signal.throwIfAborted()
  const child = spawnAgy(launch, ["--login"])
  const tree = ownProcessTree(child)
  const output = createInterface({ input: child.stdout })
  flow.submit = (code) => child.stdin.end(`${code}\n`)
  let abort = () => {}
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      child.once("error", () => reject(new Error("Could not start the Antigravity login process")))
      child.stdin.on("error", () =>
        reject(new Error("Antigravity could not receive the sign-in code")),
      )
      child.stderr.on("error", () => undefined)
      child.once("close", (code) => {
        if (code === 0 && flow.state.phase === "verifying") resolve()
        else reject(new Error("Antigravity could not complete Google sign-in"))
      })
      output.on("line", (line) => {
        const candidate = line.trim()
        if (!candidate.startsWith("https://accounts.google.com")) return
        try {
          if (flow.state.phase !== "starting")
            throw new Error("Antigravity sent multiple sign-in links")
          const authorizationUrl = googleAuthorization(candidate).href
          flow.state = { ...flow.state, phase: "waiting", authorizationUrl }
        } catch (error) {
          reject(error)
        }
      })
    })
  } finally {
    signal.removeEventListener("abort", abort)
    delete flow.submit
    output.close()
    await tree.terminate()
  }
}

export class AntigravityAccounts {
  private readonly flows = new Map<string, Flow>()
  private readonly loggingOut = new Set<string>()
  private readonly expired = new Set<string>()
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
    const state = this.flows.get(instance.dataDir)?.state
    if (state && inProgress(state)) return state
    const profile = await instanceProfile(instance)
    if (!this.expired.has(instance.dataDir) && (await hasCredential(profile)))
      return snapshot("connected")
    if (
      instance.instanceId === "antigravity" &&
      profile.directory === join(instance.dataDir, "initial") &&
      !this.expired.has(instance.dataDir)
    ) {
      const command = executable ?? (await this.installation.resolve(settings, instance))
      if (command && (await this.checkCli(instance, settings, command)))
        return { ...snapshot("connected", state?.error), usingCliLogin: true }
    }
    return state?.phase === "failed" || state?.phase === "cancelled"
      ? state
      : snapshot("signed-out")
  }

  private checkCli(instance: AgentInstanceContext, settings: AgentSettingsValues, command: string) {
    const key = JSON.stringify([command, settingEnvironment(settings)])
    const cached = this.cliChecks.get(instance.dataDir)
    if (cached?.key === key && Date.now() < cached.until) return cached.result
    const result = hasCliLogin(command, settings)
    this.cliChecks.set(instance.dataDir, { key, until: Date.now() + 10_000, result })
    return result
  }

  busy(instance: AgentInstanceContext): boolean {
    return (
      this.closed ||
      this.loggingOut.has(instance.dataDir) ||
      inProgress(this.flows.get(instance.dataDir)?.state)
    )
  }

  requireSignIn(instance: AgentInstanceContext, usingCliLogin = false): void {
    if (usingCliLogin) {
      const cached = this.cliChecks.get(instance.dataDir)
      if (cached)
        this.cliChecks.set(instance.dataDir, { ...cached, result: Promise.resolve(false) })
    } else {
      this.expired.add(instance.dataDir)
    }
    if (!this.busy(instance)) this.flows.delete(instance.dataDir)
    instance.invalidate()
  }

  async auth(
    request: AgentAuthAction,
    settings: AgentSettingsValues,
    instance: AgentInstanceContext,
  ): Promise<AgentAuthState> {
    const key = instance.dataDir
    if (request.action === "status") return this.status(instance, settings)
    if (request.action === "terminal") throw new Error("Antigravity uses the Google sign-in flow")
    if (this.closed || this.loggingOut.has(key))
      throw new Error("Antigravity account operation in progress")
    if (request.action === "logout") {
      if ((await this.status(instance, settings)).usingCliLogin)
        throw new Error("This instance uses the login managed by Antigravity CLI")
      this.loggingOut.add(key)
      try {
        await this.close(instance)
        await this.logout(settings, instance)
        this.expired.delete(key)
        return snapshot("signed-out")
      } finally {
        this.loggingOut.delete(key)
        instance.invalidate()
      }
    }
    const existing = this.flows.get(key)
    if (request.action === "start") {
      if (existing && inProgress(existing.state)) return existing.state
      const status = await this.status(instance, settings)
      if (status.phase === "connected" && !status.usingCliLogin) return status
      if (this.closed || this.loggingOut.has(key))
        throw new Error("Antigravity account operation in progress")
      const current = this.flows.get(key)
      if (current && inProgress(current.state)) return current.state
      const flow: Flow = {
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
    if (!existing || existing.state.flowId !== request.flowId || !inProgress(existing.state))
      throw new Error("This Antigravity sign-in attempt is no longer active")
    if (request.action === "cancel") {
      existing.controller.abort()
      await existing.complete
      return existing.state
    }
    if (existing.state.phase !== "waiting" || !existing.state.authorizationUrl || !existing.submit)
      throw new Error("Antigravity is not waiting for a Google authorization code")
    const code = responseCode(request.response, existing.state.authorizationUrl)
    existing.state = { ...existing.state, phase: "verifying", authorizationUrl: null }
    existing.submit(code)
    return existing.state
  }

  private async start(
    flow: Flow,
    settings: AgentSettingsValues,
    instance: AgentInstanceContext,
  ): Promise<void> {
    const deadline = AbortSignal.timeout(signInTimeout)
    const signal = AbortSignal.any([flow.controller.signal, deadline])
    const profile = newProfile(instance)
    let activated = false
    try {
      await this.stopSessions(instance)
      const previous = await instanceProfile(instance)
      await this.withLaunch(settings, instance, profile, async (launch) => {
        await authenticateCli(launch, flow, signal)
        signal.throwIfAborted()
        flow.state = { ...flow.state, phase: "verifying", authorizationUrl: null }
        await this.verify(launch, instance, signal)
      })
      if (!(await hasCredential(profile)))
        throw new Error("Antigravity did not save this instance's sign-in")
      await activateProfile(instance, profile, signal)
      activated = true
      this.expired.delete(instance.dataDir)
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
      if (!activated)
        await rm(profile.directory, { recursive: true, force: true }).catch(() => undefined)
      instance.invalidate()
    }
  }

  private async logout(
    settings: AgentSettingsValues,
    instance: AgentInstanceContext,
  ): Promise<void> {
    const profile = await instanceProfile(instance)
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
  ): Promise<T> {
    const executable = await this.installation.acquire(settings, instance)
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
