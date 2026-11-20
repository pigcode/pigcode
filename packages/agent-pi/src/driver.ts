import { randomUUID } from "node:crypto"
import { access, mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import {
  DEFAULT_RUNTIME_MODE,
  normalizeRuntimeMode,
  type AgentFeatures,
  type AgentStatus,
} from "@pigcode/contracts"
import type {
  AgentCommandInfo,
  AgentDriver,
  AgentModelInfo,
  AgentRuntime,
  AgentSessionHandle,
  AgentSettingsValues,
  CreateSessionInput,
  UserInput,
} from "@pigcode/plugin-sdk"
import { piCommand, piLaunch, piVersion, writePiExtension } from "./launch"
import { preparePackageCliUpdate } from "@pigcode/plugin-sdk/node"
import { PiRpc, deferred, record, string, type PiRecord } from "./rpc"
import { answerDialog, PiTurn } from "./turn"

const missing = "Pi native session file unavailable"
const efforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
interface Session {
  rpc: PiRpc
  fresh: boolean
  interrupted: boolean
  turn?: Promise<void>
}

function modelId(model: PiRecord) {
  return typeof model.provider === "string" && typeof model.id === "string"
    ? model.provider + "/" + model.id
    : null
}

function models(data: PiRecord, state: PiRecord): AgentModelInfo[] {
  const selected = modelId(record(state.model))
  if (!Array.isArray(data.models)) return []
  return data.models.flatMap((raw) => {
    const model = record(raw),
      id = modelId(model)
    if (!id) return []
    const values = record(model.thinkingLevelMap)
    const levels =
      model.reasoning === true
        ? efforts.filter(
            (level) =>
              values[level] !== null &&
              (!["xhigh", "max"].includes(level) || values[level] !== undefined),
          )
        : []
    const defaultLevel = string(state.thinkingLevel)
    return [
      {
        id,
        displayName: string(model.name) || string(model.id),
        isDefault: id === selected,
        efforts: levels,
        ...(id === selected && levels.includes(defaultLevel)
          ? { defaultEffort: defaultLevel }
          : {}),
      },
    ]
  })
}

export class PiDriver implements AgentDriver {
  readonly id = "pi"
  readonly displayName = "Pi"
  readonly requiresInstance = true
  readonly executionModes = { plan: false }
  readonly modelSwitch = "reuse"
  readonly features: AgentFeatures = {
    streaming: true,
    approvals: true,
    questions: true,
    plan: false,
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
  private readonly peers = new Set<PiRpc>()
  private readonly sessions = new Map<string, Session>()
  private readonly grants = new Map<string, Set<string>>()
  private extension?: ReturnType<typeof writePiExtension>
  private closed = false

  prepareCliUpdate(settings: AgentSettingsValues) {
    const { command, env } = piCommand(settings)
    return preparePackageCliUpdate({
      executable: command,
      env,
      packageName: "@earendil-works/pi-coding-agent",
      native: {
        matches: (path) =>
          !/(?:\/nix\/store\/|\/gnu\/store\/|\/mise\/|\/Cellar\/|\/Caskroom\/)/i.test(path) &&
          /\/pi(?:\.exe)?$/i.test(path),
        args: ["update", "--self"],
        versionUrl: "https://registry.npmjs.org/@earendil-works%2Fpi-coding-agent/latest",
        versionFormat: "npm",
      },
    })
  }

  private open(launch: ReturnType<typeof piLaunch>, cwd: string) {
    if (this.closed) throw new Error("Pi driver is closing")
    const rpc = new PiRpc(launch.command, launch.args, cwd, launch.env)
    this.peers.add(rpc)
    return rpc
  }
  private async finish(rpc: PiRpc) {
    try {
      await rpc.close()
    } finally {
      this.peers.delete(rpc)
    }
  }
  private async discover<T>(
    settings: AgentSettingsValues,
    cwd: string | null,
    read: (rpc: PiRpc) => Promise<T>,
  ) {
    const temp = cwd ? undefined : await mkdtemp(join(tmpdir(), "pigcode-pi-discover-"))
    let rpc: PiRpc | undefined
    try {
      rpc = this.open(piLaunch(settings, true), cwd ?? temp!)
      return await read(rpc)
    } finally {
      if (rpc) await this.finish(rpc)
      if (temp) await rm(temp, { recursive: true, force: true })
    }
  }
  async detect(settings: AgentSettingsValues): Promise<AgentStatus> {
    const { command, env } = piCommand(settings)
    const version = await piVersion(command, env)
    if (!version) return { installed: false, command, version: null, authenticated: null }
    try {
      const available = await this.listModels(settings)
      return { installed: true, command, version, authenticated: available.length > 0 }
    } catch (error) {
      return {
        installed: true,
        command,
        version,
        authenticated: null,
        error: error instanceof Error ? error.message : "Pi RPC unavailable",
      }
    }
  }
  listModels(settings: AgentSettingsValues) {
    return this.discover(settings, null, async (rpc) => {
      const [list, state] = await Promise.all([
        rpc.request("get_available_models"),
        rpc.request("get_state"),
      ])
      return models(list, state)
    })
  }
  listCommands(settings: AgentSettingsValues, cwd: string | null) {
    return this.discover(settings, cwd, async (rpc) => {
      const { commands } = await rpc.request("get_commands")
      if (!Array.isArray(commands)) return []
      return commands.flatMap((item): AgentCommandInfo[] => {
        const cmd = record(item),
          name = string(cmd.name)
        if (!name || /\s/.test(name)) return []
        return [
          {
            name,
            text: "/" + name,
            description: string(cmd.description),
            kind: cmd.source === "skill" ? "skill" : "builtin",
          },
        ]
      })
    })
  }

  async createSession(input: CreateSessionInput): Promise<AgentSessionHandle> {
    if (this.closed) throw new Error("Pi driver is closing")
    const id = input.sessionId ?? "pi_" + randomUUID()
    const prior = this.sessions.get(id)
    if (prior) await this.disposeLive(id, prior)
    if (input.planMode || input.forkFromNativeSessionId)
      throw new Error("Pi cannot start in the requested session mode")
    const policy = normalizeRuntimeMode(input.permissionMode ?? DEFAULT_RUNTIME_MODE, this.id)
    if (!policy) throw new Error("Unsupported Pi permission mode")
    input.signal?.throwIfAborted()
    const launch = piLaunch(input.settings ?? {})
    const previous = input.nativeSessionId
    if (previous) {
      if (!isAbsolute(previous)) throw new Error(missing)
      try {
        await access(previous)
      } catch {
        throw new Error(missing)
      }
      launch.args.push("--session", previous)
    }
    const bridge = await (this.extension ??= writePiExtension().catch((e) => {
      delete this.extension
      throw e
    }))
    const token = "pigcode-ready-" + randomUUID()
    launch.args.push("--extension", bridge.file)
    launch.env.PIGCODE_PI_READY = token
    launch.env.PIGCODE_PI_POLICY = policy
    delete launch.env.PIGCODE_PI_MCP
    if (input.mcp) launch.env.PIGCODE_PI_MCP = JSON.stringify(input.mcp.stdioServer())
    const rpc = this.open(launch, input.cwd)
    try {
      const timeout = AbortSignal.timeout(15_000)
      const signal = input.signal ? AbortSignal.any([timeout, input.signal]) : timeout
      const [state] = await Promise.all([
        rpc.request("get_state", {}, signal),
        rpc.until((event) => {
          if (event.type === "extension_error" && event.extensionPath === bridge.file)
            throw new Error("Pi could not load the Pigcode permission hook")
          if (
            event.type === "extension_ui_request" &&
            event.message === token &&
            event.method === "notify"
          )
            return true
          if (event.type === "extension_ui_request")
            void answerDialog(rpc, event, undefined, new Set()).catch(() => undefined)
          return undefined
        }, signal),
      ])
      const nativeSessionId = string(state.sessionFile)
      if (!isAbsolute(nativeSessionId))
        throw new Error("Pi did not return a persisted session file")
      if (
        previous &&
        previous !== nativeSessionId &&
        (await realpath(previous)) !==
          (await realpath(nativeSessionId).catch(() => nativeSessionId))
      )
        throw new Error(missing)
      if (input.model) {
        const separator = input.model.indexOf("/")
        if (separator <= 0 || separator === input.model.length - 1)
          throw new Error("Select a Pi model with a provider/model ID")
        await rpc.request(
          "set_model",
          { provider: input.model.slice(0, separator), modelId: input.model.slice(separator + 1) },
          signal,
        )
      }
      signal.throwIfAborted()
      rpc.signal.throwIfAborted()
      this.sessions.set(id, { rpc, fresh: !previous, interrupted: false })
      return {
        id,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId,
        permissionMode: policy,
        planMode: false,
        model: input.model ?? null,
      }
    } catch (error) {
      await this.finish(rpc)
      throw error
    }
  }

  async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime) {
    const live = this.sessions.get(session.id)
    if (!live) throw new Error(missing)
    if (live.turn) throw new Error("A Pi turn is already in progress")
    const run = this.run(session, live, input, runtime)
    live.turn = run
    try {
      await run
    } finally {
      await this.disposeLive(session.id, live)
    }
  }
  private async run(
    session: AgentSessionHandle,
    live: Session,
    input: UserInput,
    runtime: AgentRuntime,
  ) {
    const stop = new AbortController()
    const grants = this.grants.get(session.id) ?? new Set<string>()
    this.grants.set(session.id, grants)
    const { rpc } = live
    const onAbort = () => {
      void this.cancel(live)
    }
    runtime.signal.addEventListener("abort", onAbort, { once: true })
    try {
      runtime.signal.throwIfAborted()
      if (live.fresh && session.nativeSessionId)
        runtime.emit({ type: "session.started", nativeSessionId: session.nativeSessionId })
      if (input.effort)
        await rpc.request("set_thinking_level", { level: input.effort }, runtime.signal)
      runtime.signal.throwIfAborted()
      if (live.interrupted) throw new Error("Pi turn interrupted")
      const turn = new PiTurn(runtime, rpc, grants)
      // 扩展命令可以仅由扩展处理，此时不会有 agent_settled。
      const handled = deferred<"completed">()
      const settlement = rpc.until((event) => turn.event(event), stop.signal)
      const prompt = rpc
        .request(
          "prompt",
          { message: input.handoff ? input.handoff + "\n\n" + input.text : input.text },
          runtime.signal,
          60_000,
        )
        .then((result) => {
          if (result.disposition === "handled") handled.resolve("completed")
        })
      const [outcome] = await Promise.all([Promise.race([settlement, handled.promise]), prompt])
      if (live.interrupted || runtime.signal.aborted || outcome === "aborted")
        runtime.emit({ type: "run.interrupted" })
      else {
        const stats = await rpc
          .request("get_session_stats", {}, runtime.signal, 1500)
          .catch(() => ({}))
        const context = record(record(stats).contextUsage)
        if (
          typeof context.tokens === "number" &&
          Number.isSafeInteger(context.tokens) &&
          context.tokens >= 0
        ) {
          const maxTokens =
            typeof context.contextWindow === "number" &&
            Number.isSafeInteger(context.contextWindow) &&
            context.contextWindow > 0
              ? context.contextWindow
              : null
          runtime.emit({
            type: "context.updated",
            usedTokens: context.tokens,
            maxTokens,
            autoCompactTokens: null,
          })
        }
      }
    } catch (error) {
      if (live.interrupted || runtime.signal.aborted) runtime.emit({ type: "run.interrupted" })
      else throw error
    } finally {
      stop.abort()
      runtime.signal.removeEventListener("abort", onAbort)
    }
  }

  private async cancel(live: Session) {
    if (live.interrupted) return
    live.interrupted = true
    // Pi 能尽快终止当前模型与工具；无响应的进程由自己的进程树兜底。
    const timer = setTimeout(() => void this.finish(live.rpc), 3000)
    timer.unref()
    try {
      await live.rpc.request("abort", {}, undefined, 2000)
      await live.turn
    } catch {
      await this.finish(live.rpc)
    } finally {
      clearTimeout(timer)
    }
  }
  private async disposeLive(id: string, live: Session) {
    if (this.sessions.get(id) === live) this.sessions.delete(id)
    await this.finish(live.rpc)
  }
  async interrupt(session: AgentSessionHandle) {
    const live = this.sessions.get(session.id)
    if (live) await this.cancel(live)
  }
  async dispose(session: AgentSessionHandle) {
    const live = this.sessions.get(session.id)
    if (live) await this.disposeLive(session.id, live)
    this.grants.delete(session.id)
  }
  isSessionNotFound(message: string) {
    return message === missing
  }
  async close() {
    this.closed = true
    await Promise.all([...this.peers].map((rpc) => this.finish(rpc)))
    this.sessions.clear()
    this.grants.clear()
    const bridge = await this.extension
    if (bridge) await rm(bridge.directory, { recursive: true, force: true })
  }
}
