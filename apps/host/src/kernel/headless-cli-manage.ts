/** `pigcode-host` 的 `relay`、`devices`、`revoke` 子命令及离线配置读写实现。 */
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { Context } from "cordis"
import type { MobileRevokeResult, RelaySettingsView } from "@pigcode/contracts"
import { PairedDevices } from "../mobile/paired-devices"
import { createLocalCredentialCipher } from "../services/local-credential"
import type { RelayProbe } from "../services/relay-probe"
import { RelaySettings } from "../services/relay-settings"
import { apply as settingsPlugin, type SettingsService } from "../services/settings"
import { callAdminSocket } from "./admin-socket"
import {
  deviceNumber,
  formatDevicesTable,
  formatRelayError,
  formatRelayStatus,
  formatRevokeError,
  promptLineDefault,
  readAllStdin,
  readHiddenInputDefault,
  resolveDeviceTarget,
  type PairingDeviceView,
  type ReadableInputLike,
  type WritableStreamLike,
} from "./headless-cli-format"
import type { ConfirmPromptFn } from "./headless-cli-pair"
import { probeLiveHost } from "./host-lock"
import { ensureProfileDir } from "./profile-paths"

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

/** 在不启动 Host 的情况下只读汇总中继与已配对设备状态。 */
export function readOfflineSummary(profileDir: string): {
  relay: RelaySettingsView
  devices: PairingDeviceView[]
} {
  const settings = createReadOnlySettingsService(profileDir)
  const cipher = createLocalCredentialCipher(profileDir)
  const relay = new RelaySettings(settings, cipher)
  const paired = new PairedDevices(settings)
  return {
    relay: relay.view(),
    devices: paired.view(relay.revision, new Set()),
  }
}

async function withOfflineSettings<T>(
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
    readHiddenInput?: ((prompt: string) => Promise<string | null>) | undefined
    relayProbe?: RelayProbe | undefined
  },
): Promise<number> {
  const { stdout, stderr, stdin, env } = deps
  const resolved = resolve(profileDir)
  const meta = await probeLiveHost(resolved)

  if (command.kind === "relay-status") {
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

  if (command.kind === "relay-clear") {
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

  let resolvedToken = command.token
  if (command.tokenStdin) {
    const fromStdin = await readAllStdin(stdin)
    if (!fromStdin.trim()) {
      stderr.write("未从标准输入读取到有效的中继访问令牌。\n")
      return 2
    }
    resolvedToken = fromStdin
  } else if (resolvedToken === undefined) {
    if (!stdin.isTTY) {
      stderr.write("非交互终端下请使用 --token 或 --token-stdin 提供中继访问令牌。\n")
      return 2
    }
    const promptOut = json ? stderr : stdout
    const entered = deps.readHiddenInput
      ? await deps.readHiddenInput("请输入中继访问令牌: ")
      : await readHiddenInputDefault("请输入中继访问令牌: ", stdin, promptOut)
    if (entered === null) {
      stderr.write("已取消中继配置。\n")
      return 1
    }
    resolvedToken = entered.trim() || undefined
  }

  const params = {
    address: command.address,
    ...(resolvedToken !== undefined ? { token: resolvedToken } : {}),
  }
  let result
  if (meta) {
    try {
      result = await callAdminSocket(meta.socketPath, "relay.testAndSave", params)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stderr.write(`更新运行中的中继配置失败: ${message}\n`)
      return 1
    }
  } else {
    result = await withOfflineSettings(resolved, (settings) =>
      new RelaySettings(
        settings,
        createLocalCredentialCipher(resolved, env),
        deps.relayProbe,
      ).testAndSave(params),
    )
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

async function loadPairedDevices(
  resolvedProfileDir: string,
  stderr: WritableStreamLike,
): Promise<{
  meta: Awaited<ReturnType<typeof probeLiveHost>>
  devices: PairingDeviceView[]
} | null> {
  const meta = await probeLiveHost(resolvedProfileDir)
  if (!meta) {
    return { meta: null, devices: readOfflineSummary(resolvedProfileDir).devices }
  }
  try {
    const devices = await callAdminSocket(meta.socketPath, "mobile.devices.list", {})
    return { meta, devices }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    stderr.write(`读取已配对设备列表失败: ${message}\n`)
    return null
  }
}

export async function runDevicesCommand(
  profileDir: string,
  json: boolean,
  stdout: WritableStreamLike,
  stderr: WritableStreamLike,
): Promise<number> {
  const resolved = resolve(profileDir)
  const loaded = await loadPairedDevices(resolved, stderr)
  if (!loaded) return 1
  if (json) {
    stdout.write(
      `${JSON.stringify({ running: Boolean(loaded.meta), profileDir: resolved, devices: loaded.devices })}\n`,
    )
  } else {
    stdout.write(`${formatDevicesTable(loaded.devices)}\n`)
  }
  return 0
}

export async function runRevokeCommand(
  idOrPrefix: string,
  yes: boolean,
  profileDir: string,
  json: boolean,
  deps: {
    stdout: WritableStreamLike
    stderr: WritableStreamLike
    stdin: ReadableInputLike
    env: NodeJS.ProcessEnv
    confirmPrompt?: ConfirmPromptFn | undefined
  },
): Promise<number> {
  const { stdout, stderr, stdin, env } = deps
  const resolved = resolve(profileDir)
  const loaded = await loadPairedDevices(resolved, stderr)
  if (!loaded) return 1
  const { meta, devices } = loaded

  const targetResult = resolveDeviceTarget(devices, idOrPrefix)
  if (!targetResult.ok) {
    if (targetResult.reason === "missing") {
      stderr.write(`未找到匹配的已配对设备: ${idOrPrefix}\n`)
    } else {
      const candidates = targetResult.matches
        .map((d) => `${deviceNumber(d.id)} (${d.name})`)
        .join(", ")
      stderr.write(`匹配到多个已配对设备，请使用更精确的编号前缀: ${candidates}\n`)
    }
    return 1
  }

  const target = targetResult.device
  if (!yes) {
    if (!stdin.isTTY) {
      stderr.write("非交互终端下撤销配对需要传入 --yes 参数确认。\n")
      return 2
    }
    const controller = new AbortController()
    const prompt = `确认撤销「${target.name}」（设备编号 ${deviceNumber(target.id)}）的配对？[y/N] `
    const answer = deps.confirmPrompt
      ? await deps.confirmPrompt({ prompt, signal: controller.signal })
      : await promptLineDefault(json ? "" : prompt, stdin, stdout, controller.signal)
    const normalized = answer?.trim().toLowerCase() ?? ""
    if (normalized !== "y" && normalized !== "yes") {
      stderr.write("已取消撤销配对。\n")
      return 1
    }
  }

  let revokeResult: MobileRevokeResult
  if (meta) {
    try {
      revokeResult = await callAdminSocket(meta.socketPath, "mobile.devices.revoke", {
        deviceId: target.id,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      stderr.write(`撤销配对失败: ${message}\n`)
      return 1
    }
  } else {
    revokeResult = await withOfflineSettings(resolved, (settings) => {
      const paired = new PairedDevices(settings)
      const relay = new RelaySettings(settings, createLocalCredentialCipher(resolved, env))
      const found = paired.findById(target.id)
      if (!found) {
        return {
          status: "missing-device",
          pairing: {
            status: "idle",
            attempt: null,
            devices: paired.view(relay.revision, new Set()),
          },
        }
      }
      try {
        paired.remove(found)
      } catch {
        return {
          status: "storage-unavailable",
          pairing: {
            status: "idle",
            attempt: null,
            devices: paired.view(relay.revision, new Set()),
          },
        }
      }
      return {
        status: "revoked",
        pairing: { status: "idle", attempt: null, devices: paired.view(relay.revision, new Set()) },
      }
    })
  }

  if (revokeResult.status === "revoked") {
    if (json) stdout.write(`${JSON.stringify(revokeResult)}\n`)
    else stdout.write(`已撤销「${target.name}」（设备编号 ${deviceNumber(target.id)}）的配对。\n`)
    return 0
  }

  if (json) stdout.write(`${JSON.stringify(revokeResult)}\n`)
  else stderr.write(`${formatRevokeError(revokeResult.status)}\n`)
  return 1
}
