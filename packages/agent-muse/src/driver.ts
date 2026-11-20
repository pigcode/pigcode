import { tmpdir } from "node:os"
import { realpath } from "node:fs/promises"
import { MspError, spawnMspConnection, type SpawnedMspConnection } from "@muse-code/sdk"
import {
  NativeAgentDriver,
  missingNativeSession,
  nativeFeatures,
  record,
  stringValue,
  untilAbort,
  type NativeSession,
} from "@pigcode/native-agent-runtime"
import type { AgentStatus, AgentExecutionModes } from "@pigcode/contracts"
import {
  HOST_VERSION,
  type AgentSettingsValues,
  type CreateSessionInput,
  type AgentModelInfo,
} from "@pigcode/plugin-sdk"
import { invokeTurn } from "./turn"
import { museCommand, museVersion, prepareMuseUpdate } from "./maintenance"

async function openHost(
  settings: AgentSettingsValues,
  cwd: string | undefined,
  readOnly: boolean,
  full: boolean,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const cli = museCommand(settings)
  const args = readOnly
    ? ["serve", "--disable-shell", "--disable-write", "--no-session-log"]
    : ["serve", "--trust-workspace", ...(full ? ["--disable-sandbox"] : [])]
  const handle = spawnMspConnection({
    command: cli.command,
    args: [...cli.args, ...args],
    env: cli.env,
    ...(cwd ? { cwd } : {}),
    shutdownTimeoutMs: 3_000,
  })
  try {
    const host = await untilAbort(
      handle.initialize({
        clientInfo: { name: "pigcode", version: HOST_VERSION },
        capabilities: { requestedCapabilities: readOnly ? [] : ["sessionMcp"] },
      }),
      AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    )
    if (host.initializeResult.schema.version !== 1)
      throw new Error("Unsupported Muse Session Protocol version")
    return host
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

export class MuseDriver extends NativeAgentDriver {
  readonly id = "muse"
  readonly requiresInstance = true
  readonly displayName = "Muse Code"
  readonly executionModes: AgentExecutionModes = {
    plan: false,
    permissions: ["approval-required", "auto", "full-access"],
  }
  readonly features = {
    ...nativeFeatures,
    approvals: true,
    questions: true,
    usage: true,
    mcp: true,
  }
  async detect(settings: AgentSettingsValues): Promise<AgentStatus> {
    const cli = museCommand(settings)
    try {
      const version = await museVersion(cli)
      return {
        installed: true,
        version,
        command: cli.command,
        authenticated: null,
      }
    } catch (error) {
      return {
        installed: false,
        version: null,
        command: cli.command,
        authenticated: null,
        error: error instanceof Error ? error.message : "Muse CLI is unavailable",
      }
    }
  }
  prepareCliUpdate = prepareMuseUpdate
  async listModels(settings: AgentSettingsValues): Promise<AgentModelInfo[]> {
    const signal = AbortSignal.timeout(20_000)
    const host = await openHost(settings, tmpdir(), true, false, signal)
    try {
      const result = await untilAbort(host.connection.request("model/list", {}), signal)
      if (result.providerId !== "meta" || !Array.isArray(result.models))
        throw new Error("Invalid Muse model catalog")
      return result.models.flatMap((raw: unknown) => {
        const model = record(raw)
        if (model.providerId !== "meta" || typeof model.modelId !== "string") return []
        const efforts = Array.isArray(model.variants)
          ? model.variants.filter((x): x is string => typeof x === "string")
          : []
        return [
          {
            id: model.modelId,
            displayName: stringValue(model.displayLabel) || model.modelId,
            isDefault: model.isDefault === true,
            efforts,
            ...(typeof model.defaultReasoningEffort === "string"
              ? { defaultEffort: model.defaultReasoningEffort }
              : {}),
          },
        ]
      })
    } finally {
      await host.close()
    }
  }
  protected async open(input: CreateSessionInput, signal: AbortSignal): Promise<NativeSession> {
    const full = input.permissionMode === "full-access"
    const cwd = await realpath(input.cwd)
    const host = await openHost(input.settings ?? {}, cwd, false, full, signal)
    try {
      const nativeId = input.nativeSessionId ?? host.connection.mintCommandId()
      const mode = full ? "allowAll" : "promptUnmatched"
      if (input.mcp && !host.initializeResult.grantedCapabilities.includes("sessionMcp"))
        throw new Error("Update Muse Code to use session MCP tools")
      const config = input.mcp
        ? {
            config: {
              mcpServers: {
                pigcode: { transport: "stdio", mode: "optional", ...input.mcp.stdioServer() },
              },
            },
          }
        : {}
      const session = await untilAbort(
        host.connection.command(
          input.nativeSessionId ? "session/resume" : "session/start",
          input.nativeSessionId
            ? {
                sessionId: nativeId,
                excludeItems: true,
                ...config,
                permissionProfile: full ? ":unrestricted" : ":ask-me",
              }
            : {
                sessionId: nativeId,
                workspaceRoot: cwd,
                ...config,
                providerId: "meta",
                approvalMode: mode,
                permissionProfile: full ? ":unrestricted" : ":ask-me",
                ...(input.model ? { modelId: input.model } : {}),
              },
          { maxAttempts: 1 },
        ),
        AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      )
      if (record(session.session).sessionId !== nativeId)
        throw new Error("Muse returned an unexpected native session")
      if (record(session.history).noneReason === "projectionUnavailable")
        throw new Error("Muse cannot stream this session because its live view is unavailable")
      if (input.nativeSessionId || record(record(session.session).approvalMode).mode !== mode) {
        const applied = await untilAbort(
          host.connection.command(
            "session/setApprovalMode",
            { sessionId: nativeId, mode },
            { maxAttempts: 1 },
          ),
          signal,
        )
        if (record(applied.effectiveMode).mode !== mode)
          throw new Error("Muse did not confirm the requested approval mode")
      }
      if (input.nativeSessionId && input.model)
        await untilAbort(
          host.connection.command(
            "session/setModel",
            { sessionId: nativeId, modelId: input.model },
            { maxAttempts: 1 },
          ),
          signal,
        )
      return new MuseSession(nativeId, host, cwd)
    } catch (error) {
      await host.close().catch(() => undefined)
      if (
        input.nativeSessionId &&
        error instanceof MspError &&
        (error.kind === "sessionNotFound" || error.kind === "notFound")
      )
        throw new Error(missingNativeSession)
      throw error
    }
  }
}

class MuseSession implements NativeSession {
  private turnId?: string
  constructor(
    readonly nativeId: string,
    private readonly host: SpawnedMspConnection,
    private readonly cwd: string,
  ) {}
  async send(...[input, runtime]: Parameters<NativeSession["send"]>) {
    this.turnId = this.host.connection.mintCommandId()
    try {
      await invokeTurn(this.host, this.nativeId, this.turnId, this.cwd, input, runtime)
    } catch (error) {
      if (!runtime.signal.aborted) await this.interrupt()
      throw error
    }
  }
  async interrupt() {
    if (this.turnId)
      await untilAbort(
        this.host.connection.command(
          "turn/interrupt",
          { sessionId: this.nativeId, turnId: this.turnId },
          { maxAttempts: 1 },
        ),
        AbortSignal.timeout(3_000),
      ).catch(() => undefined)
  }
  async close() {
    await this.host.close()
  }
}
