import { execFile } from "node:child_process"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { promisify } from "node:util"
import {
  NativeAgentDriver,
  missingNativeSession,
  nativeFeatures,
  record,
  stringValue,
  type NativeSession,
} from "@pigcode/native-agent-runtime"
import type { AgentStatus } from "@pigcode/contracts"
import {
  settingString,
  type AgentInstanceContext,
  type AgentSettingsValues,
  type AgentModelInfo,
  type CreateSessionInput,
} from "@pigcode/plugin-sdk"
import { OpenCodeHttpError, OpenCodeServers, openCodeCli, type ServerApi } from "./server"
import { runOpenCodeTurn } from "./turn"
import { prepareOpenCodeUpdate } from "./maintenance"

const exec = promisify(execFile)

function modelRef(model: string | null | undefined) {
  if (!model) return undefined
  const split = model.indexOf("/")
  if (split < 1 || split === model.length - 1)
    throw new Error("OpenCode model IDs use provider/model")
  return { providerID: model.slice(0, split), id: model.slice(split + 1) }
}
function permissionRules(input: CreateSessionInput, major: number) {
  const full = input.permissionMode === "full-access",
    autoEdits = input.permissionMode === "auto-accept-edits"
  const rules: [string, "allow" | "deny" | "ask"][] = full
    ? [["*", "allow"]]
    : [
        ["*", "ask"],
        ...(["read", "glob", "grep", "list"] as const).map((action): [string, "allow"] => [
          action,
          "allow",
        ]),
        ["edit", autoEdits ? "allow" : "ask"],
        ["external_directory", "ask"],
      ]
  // The plan agent can still expose shell; permissions must also close every write path.
  const selected: typeof rules = input.planMode
    ? [
        ["*", "deny"],
        ["read", "allow"],
        ["glob", "allow"],
        ["grep", "allow"],
        ["list", "allow"],
        ["question", "allow"],
      ]
    : rules
  return selected.map(([tool, behavior]) =>
    major === 2
      ? { action: tool, resource: "*", effect: behavior }
      : { permission: tool, pattern: "*", action: behavior },
  )
}

async function models(api: ServerApi, cwd: string, signal: AbortSignal): Promise<AgentModelInfo[]> {
  const response = record(
    await api.json(api.major === 2 ? "/api/model" : "/provider", "GET", signal, undefined, cwd),
  )
  if (api.major === 2) {
    if (!Array.isArray(response.data)) throw new Error("OpenCode returned an invalid model catalog")
    return response.data.flatMap((raw: unknown) => {
      const model = record(raw)
      if (typeof model.id !== "string" || typeof model.providerID !== "string") return []
      return [
        {
          id: model.providerID + "/" + model.id,
          displayName: stringValue(model.name) || model.id,
          isDefault: false,
          ...(Array.isArray(model.variants)
            ? {
                efforts: model.variants
                  .map(record)
                  .map((v) => stringValue(v.id))
                  .filter(Boolean),
              }
            : {}),
        },
      ]
    })
  }
  if (!Array.isArray(response.all)) throw new Error("OpenCode returned an invalid model catalog")
  const connected = new Set(Array.isArray(response.connected) ? response.connected : [])
  return response.all.flatMap((raw: unknown) => {
    const source = record(raw)
    if (typeof source.id !== "string" || !connected.has(source.id)) return []
    const id = source.id
    return Object.entries(record(source.models)).map(([modelId, info]) => ({
      id: id + "/" + modelId,
      displayName: stringValue(record(info).name) || modelId,
      isDefault: record(response.default)[id] === modelId,
      efforts: Object.entries(record(record(info).variants))
        .filter(([, v]) => record(v).disabled !== true)
        .map(([variant]) => variant),
    }))
  })
}

export class OpenCodeDriver extends NativeAgentDriver {
  readonly id = "opencode"
  readonly requiresInstance = true
  readonly displayName = "OpenCode"
  readonly executionModes = { plan: true }
  readonly features = {
    ...nativeFeatures,
    approvals: true,
    questions: true,
    plan: true,
    usage: true,
  }
  private readonly servers = new OpenCodeServers()
  private readonly grants = new Map<string, Set<string>>()

  async detect(settings: AgentSettingsValues, scope?: AgentInstanceContext): Promise<AgentStatus> {
    const url = settingString(settings, "serverUrl")
    let command = url ?? settingString(settings, "binaryPath") ?? "opencode"
    try {
      if (url) {
        const lease = await this.servers.get(
          settings,
          scope?.dataDir ?? tmpdir(),
          AbortSignal.timeout(9_000),
          scope?.instanceId,
        )
        try {
          return { installed: true, authenticated: null, version: lease.api.version, command: url }
        } finally {
          await lease.release()
        }
      }
      const cli = openCodeCli(settings)
      command = cli.command
      const { stdout } = await exec(cli.command, [...cli.args, "--version"], {
        env: cli.env,
        timeout: 5_000,
        windowsHide: true,
      })
      return {
        installed: true,
        authenticated: null,
        version: stdout.trim().match(/\d+\.\d+\.\d+[^\s]*/)?.[0] ?? null,
        command: cli.command,
      }
    } catch (error) {
      return {
        installed: false,
        authenticated: error instanceof OpenCodeHttpError && error.status === 401 ? false : null,
        version: null,
        command,
        error: error instanceof Error ? error.message : "Could not check OpenCode",
      }
    }
  }

  prepareCliUpdate(settings: AgentSettingsValues) {
    const local = { ...settings, serverUrl: "" }
    return prepareOpenCodeUpdate(
      settings,
      async () => (await this.detect(local)).version,
      () => this.servers.updated(openCodeCli(settings).executable),
    )
  }

  async listModels(
    settings: AgentSettingsValues,
    scope?: AgentInstanceContext,
  ): Promise<AgentModelInfo[]> {
    const cwd = scope?.dataDir ?? tmpdir()
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    const signal = AbortSignal.timeout(35_000)
    const lease = await this.servers.get(settings, cwd, signal, scope?.instanceId)
    try {
      return await models(lease.api, cwd, signal)
    } finally {
      await lease.release()
    }
  }

  protected async open(input: CreateSessionInput, signal: AbortSignal): Promise<NativeSession> {
    const lease = await this.servers.get(
      input.settings ?? {},
      input.cwd,
      signal,
      input.instance?.instanceId,
    )
    const api = lease.api,
      v2 = api.major === 2
    const base = v2 ? "/api/session" : "/session"
    const setup = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    try {
      const model = modelRef(input.model),
        agent = input.planMode ? "plan" : "build"
      const rules = permissionRules(input, api.major)
      let nativeId = input.nativeSessionId
      if (nativeId) {
        const path = base + "/" + encodeURIComponent(nativeId)
        await api.json(path, "GET", setup, undefined, input.cwd)
        await api.json(
          path,
          "PATCH",
          setup,
          v2 ? { permissions: rules } : { permission: rules },
          input.cwd,
        )
        if (v2) {
          await api.json(path + "/agent", "POST", setup, { agent })
          if (model) await api.json(path + "/model", "POST", setup, { model })
        }
      } else {
        const response = record(
          await api.json(
            base,
            "POST",
            setup,
            v2
              ? {
                  location: { directory: input.cwd },
                  agent,
                  ...(model ? { model } : {}),
                  permissions: rules,
                }
              : { permission: rules },
            input.cwd,
          ),
        )
        nativeId = stringValue(v2 ? record(response.data).id : response.id)
        if (!nativeId) throw new Error("OpenCode returned no session ID")
      }
      const id = nativeId
      const grantKey = JSON.stringify([
        input.instance?.instanceId,
        settingString(input.settings, "serverUrl"),
        input.threadId,
        id,
        input.permissionMode,
        input.planMode,
      ])
      const grants = this.grants.get(grantKey) ?? new Set<string>()
      this.grants.set(grantKey, grants)
      let cancelTurn = async () => {}
      return {
        nativeId: id,
        send: async (turn, runtime) => {
          try {
            await runOpenCodeTurn(
              api,
              id,
              input.cwd,
              turn,
              runtime,
              grants,
              agent,
              model,
              (cancel) => {
                cancelTurn = cancel
              },
            )
          } finally {
            cancelTurn = async () => {}
          }
        },
        interrupt: () => cancelTurn(),
        close: lease.release,
      }
    } catch (error) {
      await lease.release()
      if (input.nativeSessionId && error instanceof OpenCodeHttpError && error.status === 404)
        throw new Error(missingNativeSession)
      throw error
    }
  }
  override async close() {
    await super.close()
    await this.servers.close()
    this.grants.clear()
  }
}
