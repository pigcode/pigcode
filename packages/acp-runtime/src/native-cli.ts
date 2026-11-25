import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { InitializeResponse } from "@agentclientprotocol/sdk"
import { promisify } from "node:util"
import {
  DEFAULT_RUNTIME_MODE,
  normalizeRuntimeMode,
  type AgentFeatures,
  type AgentStatus,
  type RuntimeMode,
} from "@pigcode/contracts"
import {
  settingEnvironment,
  settingString,
  type AgentCommandInfo,
  type AgentCliUpdatePlan,
  type AgentDriver,
  type AgentInstanceContext,
  type AgentModelInfo,
  type AgentRuntime,
  type AgentSessionHandle,
  type AgentSettingsValues,
  type CreateSessionInput,
  type PluginHostContext,
  type UserInput,
} from "@pigcode/plugin-sdk"
import {
  agentEnvironment,
  cliVersion,
  expandHome,
  findExecutable,
  launchTarget,
} from "@pigcode/plugin-sdk/node"
import { AcpRuntime, missingSession, type AcpRuntimeOptions } from "./runtime"

export interface CliOutput {
  ok: boolean
  text: string
}
export type CliProbe = (args: string[]) => Promise<CliOutput>
export interface NativeAcpDefinition {
  id: string
  name: string
  command: string
  args(mode?: RuntimeMode): string[]
  environment?(settings: AgentSettingsValues): Record<string, string>
  prepareUpdate?(command: string, env: NodeJS.ProcessEnv): Promise<AgentCliUpdatePlan>
  account(
    run: CliProbe,
    env: NodeJS.ProcessEnv,
  ): Promise<Pick<AgentStatus, "authenticated" | "account" | "email">>
  models(run: CliProbe, env: NodeJS.ProcessEnv): Promise<AgentModelInfo[]>
  metadata?(info: InitializeResponse): { models: AgentModelInfo[]; commands: AgentCommandInfo[] }
  protocol?: Omit<AcpRuntimeOptions, "id" | "name">
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function parseCliObject(value: string) {
  try {
    return jsonRecord(JSON.parse(value))
  } catch {
    return {}
  }
}

const execute = promisify(execFile)

/** 名称按照实例 PATH 与桌面应用常用安装目录解析；只读探测不加载工作区。 */
export function cliExecutable(command: string, env: NodeJS.ProcessEnv) {
  const path = expandHome(command)
  return /[\\/]/.test(path) ? resolve(path) : (findExecutable(path, undefined, env.PATH) ?? path)
}

export function probeCli(command: string, env: NodeJS.ProcessEnv, cwd = tmpdir()): CliProbe {
  return async (args) => {
    const target = launchTarget(command, args)
    if (target.shell) return { ok: false, text: "" }
    try {
      const result = await execute(target.command, target.args, {
        env,
        cwd,
        encoding: "utf8",
        timeout: 8_000,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      })
      return { ok: true, text: result.stdout.trim() || result.stderr.trim() }
    } catch (error) {
      const detail = jsonRecord(error)
      return { ok: false, text: typeof detail.stdout === "string" ? detail.stdout.trim() : "" }
    }
  }
}

/** 原生 ACP 命令共享进程、会话、审批和 MCP 桥；各 CLI 声明自己的启动和账号约定。 */
export class NativeAcpDriver implements AgentDriver {
  readonly requiresInstance = true
  readonly id: string
  readonly displayName: string
  readonly modelSwitch = "reuse"
  readonly executionModes = { plan: false }
  readonly features: AgentFeatures = {
    streaming: true,
    approvals: true,
    questions: false,
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
  private readonly runtime: AcpRuntime
  readonly prepareCliUpdate?: (settings: AgentSettingsValues) => Promise<AgentCliUpdatePlan>

  constructor(private readonly definition: NativeAcpDefinition) {
    this.id = definition.id
    this.displayName = definition.name
    const update = definition.prepareUpdate
    if (update)
      this.prepareCliUpdate = (settings) => {
        const { command, env } = this.launch(settings, tmpdir())
        return update(command, env)
      }
    this.runtime = new AcpRuntime({
      id: this.id,
      name: this.displayName,
      retainLiveOnly: true,
      ...definition.protocol,
    })
  }

  private launch(settings: AgentSettingsValues, cwd: string, mode?: RuntimeMode) {
    const env = agentEnvironment(
      settingEnvironment(settings),
      this.definition.environment?.(settings),
    )
    const command = cliExecutable(
      settingString(settings, "binaryPath") ?? this.definition.command,
      env,
    )
    return { command, args: this.definition.args(mode), env, cwd }
  }

  private scope(settings: AgentSettingsValues, instance?: AgentInstanceContext) {
    return instance?.dataDir ?? createHash("sha256").update(JSON.stringify(settings)).digest("hex")
  }

  async detect(settings: AgentSettingsValues): Promise<AgentStatus> {
    const { command, env } = this.launch(settings, tmpdir())
    const run = probeCli(command, env)
    const version = await run(["--version"])
    if (!version.ok) return { installed: false, version: null, authenticated: null, command }
    return {
      installed: true,
      command,
      version: cliVersion(version.text),
      ...(await this.definition.account(run, env)),
    }
  }

  /** Grok 将模型和命令放在 initialize 的元数据中。读取它不会建立会话或触发登录。 */
  private async metadata(settings: AgentSettingsValues) {
    const read = this.definition.metadata
    if (!read) return undefined
    const rpc = this.runtime.open(this.launch(settings, tmpdir()), this.scope(settings))
    try {
      return read(await rpc.initialize(AbortSignal.timeout(6000)))
    } finally {
      await this.runtime.closeProcess(rpc)
    }
  }

  async listModels(settings: AgentSettingsValues) {
    const { command, env } = this.launch(settings, tmpdir())
    const [cli, metadata] = await Promise.all([
      this.definition.models(probeCli(command, env), env),
      this.metadata(settings).catch(() => undefined),
    ])
    const models = new Map(cli.map((model) => [model.id, model]))
    for (const model of metadata?.models ?? []) models.set(model.id, model)
    return [...models.values()]
  }

  async listCommands(
    settings: AgentSettingsValues,
    cwd: string | null,
    instance?: AgentInstanceContext,
  ) {
    const scope = this.scope(settings, instance)
    const known = this.runtime.readCommands(scope, cwd)
    if (known) return known
    if (this.definition.metadata)
      return (await this.metadata(settings).catch(() => undefined))?.commands ?? []
    // 未登录时原生 CLI 可能自动发起交互式登录，斜杠菜单只探测可用账号。
    const status = await this.detect(settings)
    if (!status.installed || status.authenticated !== true) return []
    const directory = await mkdtemp(join(tmpdir(), "pigcode-acp-commands-"))
    try {
      await this.runtime.readCatalog(this.launch(settings, directory), scope)
      return this.runtime.readCommands(scope, cwd) ?? []
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }

  createSession(input: CreateSessionInput) {
    const settings = input.settings ?? {}
    const mode = normalizeRuntimeMode(input.permissionMode ?? DEFAULT_RUNTIME_MODE, this.id)
    if (!mode || input.planMode)
      throw new Error("Unsupported " + this.displayName + " runtime mode")
    return this.runtime.createSession(
      input,
      this.launch(settings, input.cwd, mode),
      this.scope(settings, input.instance),
    )
  }
  send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime) {
    return this.runtime.send(session, input, runtime)
  }
  handlesImages() {
    return true
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
  close() {
    return this.runtime.close()
  }
}

export function registerNativeAcp(ctx: PluginHostContext, definition: NativeAcpDefinition) {
  const driver = new NativeAcpDriver(definition)
  ctx.agents.register(driver)
  ctx.effect(() => async () => {
    ctx.agents.unregister(driver.id)
    await driver.close()
  })
}
