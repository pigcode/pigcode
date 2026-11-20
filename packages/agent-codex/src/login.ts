import { createHash, randomUUID } from "node:crypto"
import { renameSync } from "node:fs"
import { chmod, copyFile, lstat, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import type { AgentAuthAction, AgentAuthState } from "@pigcode/contracts"
import type { AgentInstanceContext, AgentSettingsValues } from "@pigcode/plugin-sdk"
import { parseCodexAccount, type CodexAccount } from "./account"
import { codexLaunch, launchKey, type PrepareCodexLaunch, type CodexLaunch } from "./launch"
import { shadowCodexHome } from "./shadow-home"
import type { CodexRpcClient } from "./client"

const loginTimeout = 15 * 60_000
const methods = [
  { id: "chatgpt", name: "ChatGPT" },
  { id: "chatgptDeviceCode", name: "ChatGPT · Device code" },
]
const identity = (phase: AgentAuthState["phase"], error: string | null = null): AgentAuthState => ({
  phase,
  error,
  authorizationUrl: null,
  expiresAt: null,
  flowId: null,
})
const pending = (state: AgentAuthState) =>
  state.phase === "starting" || state.phase === "waiting" || state.phase === "verifying"

interface Login {
  target: string
  state: AgentAuthState
  controller: AbortController
  done: Promise<void>
}
interface Completed {
  loginId?: string | null
  success?: boolean
}
interface StartReply {
  type?: string
  loginId?: string
  authUrl?: string
  verificationUrl?: string
  userCode?: string
}

function authorizationUrl(raw: unknown) {
  const url = typeof raw === "string" && raw.length < 16_384 ? URL.parse(raw) : null
  if (
    !url ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !["auth.openai.com", "auth0.openai.com", "auth.chatgpt.com", "chatgpt.com"].includes(
      url.hostname,
    )
  )
    throw new Error("Codex returned an invalid ChatGPT sign-in link")
  return url.href
}

export class CodexAccounts {
  private readonly logins = new Map<string, Login>()
  private readonly loggingOut = new Set<string>()
  private closed = false
  constructor(
    private readonly launch: PrepareCodexLaunch,
    private readonly open: (launch: CodexLaunch) => CodexRpcClient,
    private readonly stop: (client: CodexRpcClient) => Promise<void>,
    private readonly initialize: (client: CodexRpcClient) => Promise<void>,
    private readonly stopSessions: (scope: AgentInstanceContext) => Promise<void>,
  ) {}

  busy(scope: AgentInstanceContext) {
    const login = this.logins.get(scope.dataDir)
    return (
      this.closed || this.loggingOut.has(scope.dataDir) || Boolean(login && pending(login.state))
    )
  }

  async read(launch: CodexLaunch, signal?: AbortSignal): Promise<CodexAccount | null> {
    signal?.throwIfAborted()
    const client = this.open(launch)
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopWaiting = () => {}
    try {
      const read = (async () => {
        await this.initialize(client)
        return parseCodexAccount(await client.request("account/read", {}))
      })()
      const timeout = new Promise<null>((resolve) => {
        stopWaiting = () => resolve(null)
        timer = setTimeout(stopWaiting, 8000)
        timer.unref()
        signal?.addEventListener("abort", stopWaiting, { once: true })
        if (signal?.aborted) stopWaiting()
      })
      return await Promise.race([read, timeout])
    } catch {
      return null
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", stopWaiting)
      await this.stop(client)
    }
  }

  async auth(
    request: AgentAuthAction,
    settings: AgentSettingsValues,
    scope: AgentInstanceContext,
  ): Promise<AgentAuthState> {
    const key = scope.dataDir
    const privateHome = Boolean(shadowCodexHome(settings, scope))
    const target = createHash("sha256")
      .update(launchKey(codexLaunch(settings, scope)))
      .digest("hex")
    let existing = this.logins.get(key)
    if (existing && existing.target !== target) {
      existing.controller.abort()
      await existing.done
      if (this.logins.get(key) === existing) this.logins.delete(key)
      existing = this.logins.get(key)
    }
    const expose = (state: AgentAuthState): AgentAuthState => ({
      ...state,
      methods: privateHome ? methods : [],
      canLogout: privateHome,
      ...(!privateHome ? { usingCliLogin: true } : {}),
    })
    if (request.action === "status") {
      if (existing && (pending(existing.state) || !request.refresh)) return expose(existing.state)
      const launch = await this.launch(settings, scope)
      if (!launch) return expose(identity("signed-out"))
      const account = await this.read(launch)
      const connected =
        settings.setupMode === "managed" ? account?.label?.startsWith("ChatGPT") : account?.loggedIn
      const state = account
        ? identity(connected ? "connected" : "signed-out")
        : identity("failed", "Could not read the Codex account on this instance")
      if (existing && !pending(existing.state)) existing.state = state
      return expose(state)
    }
    if (!privateHome)
      throw new Error(
        "ChatGPT account management requires a managed instance or a private shadow home",
      )
    if (request.action === "cancel") {
      if (!existing || existing.state.flowId !== request.flowId)
        throw new Error("This Codex sign-in attempt is no longer active")
      existing.controller.abort()
      await existing.done
      return expose(existing.state)
    }
    if (this.loggingOut.has(key)) throw new Error("Codex sign-out is in progress")
    if (request.action === "logout") {
      this.loggingOut.add(key)
      try {
        await this.close(scope)
        const launch = await this.launch(settings, scope)
        if (!launch) return expose(identity("signed-out"))
        const client = this.open(launch)
        try {
          await this.initialize(client)
          await client.request("account/logout", {})
        } finally {
          await this.stop(client)
        }
        if ((await this.read(launch))?.loggedIn !== false)
          throw new Error("Could not verify Codex sign-out")
        scope.invalidate()
        return expose(identity("signed-out"))
      } finally {
        this.loggingOut.delete(key)
      }
    }
    if (request.action !== "start")
      throw new Error("Complete this login in the ChatGPT authorization page")
    if (this.closed) throw new Error("Codex is shutting down")
    if (existing && pending(existing.state)) return expose(existing.state)
    const method = request.methodId ?? "chatgpt"
    if (!methods.some(({ id }) => id === method)) throw new Error("Unknown Codex sign-in method")
    const login: Login = {
      target,
      controller: new AbortController(),
      done: Promise.resolve(),
      state: {
        ...identity("starting"),
        flowId: randomUUID(),
        expiresAt: Date.now() + loginTimeout,
      },
    }
    this.logins.set(key, login)
    login.done = this.start(login, settings, scope, method)
    return expose(login.state)
  }

  private async start(
    login: Login,
    settings: AgentSettingsValues,
    scope: AgentInstanceContext,
    method: string,
  ) {
    const deadline = AbortSignal.timeout(loginTimeout)
    const signal = AbortSignal.any([login.controller.signal, deadline])
    let staging: string | undefined
    try {
      const launch = await this.launch(settings, scope, signal)
      if (!launch) throw new Error("Codex runtime is unavailable")
      const home = launch.env?.CODEX_HOME
      if (!launch.isolatedAccount || !home) throw new Error("Codex sign-in needs a private home")
      signal.throwIfAborted()
      // 每次尝试都在独立目录写凭据，避免旧账号或晚到的 OAuth 结果影响正式 home。
      staging = await mkdtemp(join(home, ".pigcode-login-"))
      await copyFile(join(home, "config.toml"), join(staging, "config.toml")).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      })
      const attempt = { ...launch, env: { ...launch.env, CODEX_HOME: staging } }
      signal.throwIfAborted()
      const client = this.open(attempt)
      let loginId: string | undefined
      const early = new Map<string, boolean>()
      let removeAbort = () => {}
      let settle!: (ok: boolean) => void
      const completed = new Promise<boolean>((resolve) => {
        settle = resolve
      })
      const off = client.onNotification("account/login/completed", (raw) => {
        if (!raw || typeof raw !== "object") return
        const event = raw as Completed
        if (typeof event.loginId !== "string") return
        if (!loginId) early.set(event.loginId, event.success === true)
        else if (event.loginId === loginId) settle(event.success === true)
      })
      const offClose = client.onClose(() => settle(false))
      const aborted = new Promise<never>((_, reject) => {
        const abort = () => reject(signal.reason)
        signal.addEventListener("abort", abort, { once: true })
        removeAbort = () => signal.removeEventListener("abort", abort)
        if (signal.aborted) abort()
      })
      try {
        await Promise.race([this.initialize(client), aborted])
        const started = (await Promise.race([
          client.request("account/login/start", { type: method }),
          aborted,
        ])) as StartReply
        if (started.type !== method || !started.loginId)
          throw new Error("Codex did not start this ChatGPT sign-in")
        loginId = started.loginId
        const url = authorizationUrl(
          method === "chatgpt" ? started.authUrl : started.verificationUrl,
        )
        if (
          method === "chatgptDeviceCode" &&
          (typeof started.userCode !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(started.userCode))
        )
          throw new Error("Codex did not return a valid device code")
        login.state = {
          ...login.state,
          phase: "waiting",
          authorizationUrl: url,
          ...(started.userCode ? { userCode: started.userCode } : {}),
        }
        const alreadyFinished = early.get(loginId)
        if (alreadyFinished !== undefined) settle(alreadyFinished)
        if (!(await Promise.race([completed, aborted])))
          throw new Error("ChatGPT sign-in did not complete")
      } finally {
        removeAbort()
        off()
        offClose()
        if (signal.aborted && loginId) {
          let timer: ReturnType<typeof setTimeout> | undefined
          await Promise.race([
            client.request("account/login/cancel", { loginId }).catch(() => undefined),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 1500)
              timer.unref()
            }),
          ]).finally(() => clearTimeout(timer))
        }
        await this.stop(client)
      }
      signal.throwIfAborted()
      login.state = {
        ...identity("verifying"),
        flowId: login.state.flowId,
        expiresAt: login.state.expiresAt,
      }
      const verified = await this.read(attempt, signal)
      signal.throwIfAborted()
      if (!verified?.loggedIn || !verified.label?.startsWith("ChatGPT"))
        throw new Error("Codex could not verify the ChatGPT account")
      const credentials = join(staging, "auth.json")
      const info = await lstat(credentials)
      if (!info.isFile() || info.nlink !== 1 || !info.size)
        throw new Error("Codex did not save private ChatGPT credentials")
      if (process.platform !== "win32") await chmod(credentials, 0o600)
      signal.throwIfAborted()
      await this.stopSessions(scope)
      signal.throwIfAborted()
      // 同一事件循环内提交凭据和状态，取消请求不能落在两者之间。
      renameSync(credentials, join(home, "auth.json"))
      login.state = identity("connected")
    } catch (error) {
      login.state = login.controller.signal.aborted
        ? identity("cancelled")
        : identity(
            "failed",
            deadline.aborted
              ? "ChatGPT sign-in expired"
              : error instanceof Error
                ? error.message
                : "Could not sign in to ChatGPT",
          )
    } finally {
      if (staging)
        await rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
      scope.invalidate()
    }
  }

  async close(scope: AgentInstanceContext) {
    const login = this.logins.get(scope.dataDir)
    if (login) {
      login.controller.abort()
      await login.done
      if (this.logins.get(scope.dataDir) === login) this.logins.delete(scope.dataDir)
    }
    await this.stopSessions(scope)
  }

  async dispose() {
    this.closed = true
    for (const login of this.logins.values()) login.controller.abort()
    await Promise.all([...this.logins.values()].map((login) => login.done))
    this.logins.clear()
  }
}
