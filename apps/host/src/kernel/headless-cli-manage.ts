/** `pigcode-host` 的 `relay`、`devices`、`revoke` 子命令及离线配置读写实现。 */
import { existsSync, readFileSync } from "node:fs"
import { hostname } from "node:os"
import { join, resolve } from "node:path"
import { Context } from "cordis"
import {
  relayTestAndSaveParamsSchema,
  type DesktopAuthorizedClient,
  type RelaySettingsView,
} from "@pigcode/contracts"
import { PairedDevices } from "../mobile/paired-devices"
import { createLocalCredentialCipher } from "../services/local-credential"
import type { RelayProbe } from "../services/relay-probe"
import { normalizeRelayAddress, RelaySettings } from "../services/relay-settings"
import { apply as settingsPlugin, type SettingsService } from "../services/settings"
import { callAdminSocket } from "./admin-socket"
import {
  formatRelayError,
  formatRelayStatus,
  readAllStdin,
  readHiddenInputDefault,
  type PairingDeviceView,
  type ReadableInputLike,
  type SignalSource,
  type WritableStreamLike,
} from "./headless-cli-format"
import { probeLiveHost } from "./host-lock"
import { ensureProfileDir } from "./profile-paths"

export { runDevicesCommand, runRevokeCommand } from "./headless-cli-devices"

function readSettingsJsonReadOnly(profileDir: string): Record<string, unknown> {
  try {
    const raw = readFileSync(join(profileDir, "settings.json"), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 离线只读场景下不存在或损坏的设置文件按空表处理，不改动磁盘状态。
  }
  return {}
}

function createReadOnlySettingsService(profileDir: string): SettingsService {
  const values = readSettingsJsonReadOnly(profileDir)
  return {
    directory: profileDir,
    get: (key) => values[key],
    set: () => {
      throw new Error("read-only settings service")
    },
    snapshot: () => values,
    onChange: () => () => undefined,
  }
}

/** 在不启动 Host 的情况下只读汇总中继、主机名与已配对设备状态。 */
export function readOfflineSummary(profileDir: string): {
  hostName: string
  relay: RelaySettingsView
  devices: PairingDeviceView[]
  desktopClients: DesktopAuthorizedClient[]
} {
  const settings = createReadOnlySettingsService(profileDir)
  const cipher = createLocalCredentialCipher(profileDir)
  const relay = new RelaySettings(settings, cipher)
  const paired = new PairedDevices(settings)
  const rawName = settings.get("host.name")
  const fallback = hostname().split(".")[0]?.slice(0, 80) || "Pigcode"
  const hostName =
    typeof rawName === "string" && rawName.trim() ? rawName.trim().slice(0, 80) : fallback
  return {
    hostName,
    relay: relay.view(),
    devices: paired.view(relay.revision, new Set()),
    desktopClients: paired.desktopView(new Set()),
  }
}

export async function withOfflineSettings<T>(
  profileDir: string,
  fn: (settings: SettingsService) => Promise<T> | T,
): Promise<T> {
  ensureProfileDir(profileDir)
  const ctx = new Context()
  await ctx.plugin(settingsPlugin, { path: join(profileDir, "settings.json") })
  try {
    return await fn(ctx.settings)
  } finally {
    await ctx.fiber.dispose()
  }
}

async function runRelayStatus(
  resolved: string,
  json: boolean,
  stdout: WritableStreamLike,
  stderr: WritableStreamLike,
): Promise<number> {
  const meta = await probeLiveHost(resolved)
  let view: RelaySettingsView
  if (meta) {
    try {
      view = await callAdminSocket(meta.socketPath, "relay.view", {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stderr.write(`读取运行中的中继配置失败: ${message}\n`)
      return 1
    }
  } else {
    view = readOfflineSummary(resolved).relay
  }
  if (json) {
    stdout.write(`${JSON.stringify({ running: Boolean(meta), profileDir: resolved, ...view })}\n`)
  } else {
    stdout.write(`${formatRelayStatus(view, Boolean(meta))}\n`)
  }
  return 0
}

async function runRelayClear(
  resolved: string,
  json: boolean,
  stdout: WritableStreamLike,
  stderr: WritableStreamLike,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const meta = await probeLiveHost(resolved)
  let view: RelaySettingsView
  if (meta) {
    try {
      view = await callAdminSocket(meta.socketPath, "relay.clear", {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stderr.write(`清除运行中的中继配置失败: ${message}\n`)
      return 1
    }
  } else if (existsSync(join(resolved, "settings.json"))) {
    view = await withOfflineSettings(resolved, (settings) =>
      new RelaySettings(settings, createLocalCredentialCipher(resolved, env)).clear(),
    )
  } else {
    view = { address: null, tokenConfigured: false }
  }
  if (json) stdout.write(`${JSON.stringify(view)}\n`)
  else stdout.write("已清除中继配置。\n")
  return 0
}

async function resolveRelaySetToken(
  command: { token?: string | undefined; tokenStdin: boolean },
  json: boolean,
  deps: {
    stdout: WritableStreamLike
    stderr: WritableStreamLike
    stdin: ReadableInputLike
    signalSource: SignalSource
    readHiddenInput?: ((prompt: string) => Promise<string | null>) | undefined
  },
): Promise<{ ok: true; token: string | undefined } | { ok: false; code: number }> {
  const { stdout, stderr, stdin, signalSource } = deps
  if (command.tokenStdin) {
    let fromStdin: string
    try {
      fromStdin = await readAllStdin(stdin)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stderr.write(`${message}\n`)
      return { ok: false, code: 2 }
    }
    if (!fromStdin.trim()) {
      stderr.write("未从标准输入读取到有效的中继访问令牌。\n")
      return { ok: false, code: 2 }
    }
    return { ok: true, token: fromStdin }
  }
  if (command.token !== undefined) {
    return { ok: true, token: command.token }
  }
  if (!stdin.isTTY) {
    stderr.write("非交互终端下请使用 --token 或 --token-stdin 提供中继访问令牌。\n")
    return { ok: false, code: 2 }
  }
  const promptOut = json ? stderr : stdout
  let entered: string | null
  try {
    entered = deps.readHiddenInput
      ? await deps.readHiddenInput("请输入中继访问令牌: ")
      : await readHiddenInputDefault("请输入中继访问令牌: ", stdin, promptOut, signalSource)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`${message}\n`)
    return { ok: false, code: 2 }
  }
  if (entered === null) {
    stderr.write("已取消中继配置。\n")
    return { ok: false, code: 1 }
  }
  return { ok: true, token: entered.trim() || undefined }
}

async function runRelaySet(
  command: { address: string; token?: string | undefined; tokenStdin: boolean },
  resolved: string,
  json: boolean,
  deps: {
    stdout: WritableStreamLike
    stderr: WritableStreamLike
    stdin: ReadableInputLike
    env: NodeJS.ProcessEnv
    signalSource: SignalSource
    readHiddenInput?: ((prompt: string) => Promise<string | null>) | undefined
    relayProbe?: RelayProbe | undefined
  },
): Promise<number> {
  const { stdout, stderr, env } = deps
  const tokenResult = await resolveRelaySetToken(command, json, deps)
  if (!tokenResult.ok) return tokenResult.code

  const params = {
    address: command.address,
    ...(tokenResult.token !== undefined ? { token: tokenResult.token } : {}),
  }
  const validated = relayTestAndSaveParamsSchema.safeParse(params)
  if (!validated.success) {
    const reason = validated.error.issues[0]?.message || "中继配置参数格式无效或超出 4096 字符限制"
    stderr.write(`${reason}\n`)
    return 2
  }

  // 完成用户输入与参数校验后再探测 Host，避免输入等待期间产生状态竞态。
  const meta = await probeLiveHost(resolved)
  let result
  if (meta) {
    try {
      result = await callAdminSocket(meta.socketPath, "relay.testAndSave", validated.data)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stderr.write(`更新运行中的中继配置失败: ${message}\n`)
      return 1
    }
  } else {
    if (!normalizeRelayAddress(validated.data.address)) {
      result = { status: "invalid-address" as const }
    } else {
      result = await withOfflineSettings(resolved, (settings) =>
        new RelaySettings(
          settings,
          createLocalCredentialCipher(resolved, env),
          deps.relayProbe,
        ).testAndSave(validated.data),
      )
    }
  }

  if (result.status === "saved") {
    if (json) stdout.write(`${JSON.stringify(result)}\n`)
    else stdout.write("中继连接测试通过，配置已保存。\n")
    return 0
  }

  if (json) stdout.write(`${JSON.stringify(result)}\n`)
  else stderr.write(`${formatRelayError(result.status)}\n`)
  return 1
}

export async function runRelayCommand(
  command:
    | { kind: "relay-status" }
    | { kind: "relay-set"; address: string; token?: string | undefined; tokenStdin: boolean }
    | { kind: "relay-clear" },
  profileDir: string,
  json: boolean,
  deps: {
    stdout: WritableStreamLike
    stderr: WritableStreamLike
    stdin: ReadableInputLike
    env: NodeJS.ProcessEnv
    signalSource: SignalSource
    readHiddenInput?: ((prompt: string) => Promise<string | null>) | undefined
    relayProbe?: RelayProbe | undefined
  },
): Promise<number> {
  const resolved = resolve(profileDir)
  switch (command.kind) {
    case "relay-status":
      return runRelayStatus(resolved, json, deps.stdout, deps.stderr)
    case "relay-clear":
      return runRelayClear(resolved, json, deps.stdout, deps.stderr, deps.env)
    case "relay-set":
      return runRelaySet(command, resolved, json, deps)
  }
}

export async function runNameCommand(
  newName: string | undefined,
  profileDir: string,
  json: boolean,
  stdout: WritableStreamLike,
  stderr: WritableStreamLike,
): Promise<number> {
  const resolved = resolve(profileDir)
  const meta = await probeLiveHost(resolved)

  if (newName === undefined) {
    let hostName: string
    if (meta) {
      try {
        const status = await callAdminSocket(meta.socketPath, "host.status", {})
        hostName = status.hostName ?? readOfflineSummary(resolved).hostName
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        stderr.write(`读取主机名称失败: ${message}\n`)
        return 1
      }
    } else {
      hostName = readOfflineSummary(resolved).hostName
    }
    if (json)
      stdout.write(
        `${JSON.stringify({ running: Boolean(meta), profileDir: resolved, hostName })}\n`,
      )
    else stdout.write(`${hostName}\n`)
    return 0
  }

  const trimmed = newName.trim().slice(0, 80)
  if (!trimmed) {
    stderr.write("主机名不能为空。\n")
    return 2
  }
  let updated: string
  if (meta) {
    try {
      const result = await callAdminSocket(meta.socketPath, "host.setName", { name: trimmed })
      updated = result.hostName
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stderr.write(`修改主机名称失败: ${message}\n`)
      return 1
    }
  } else {
    updated = await withOfflineSettings(resolved, (settings) => {
      settings.set("host.name", trimmed)
      return trimmed
    })
  }
  if (json)
    stdout.write(
      `${JSON.stringify({ running: Boolean(meta), profileDir: resolved, hostName: updated })}\n`,
    )
  else stdout.write(`主机名已更新为: ${updated}\n`)
  return 0
}
