/** `pigcode` CLI 的 `devices` 与 `revoke` 子命令实现。 */
import { resolve } from "node:path"
import type { DesktopAuthorizedClient } from "@pigcode/contracts"
import { PairedDevices } from "../mobile/paired-devices"
import { createLocalCredentialCipher } from "../services/local-credential"
import { RelaySettings } from "../services/relay-settings"
import { callAdminSocket } from "./admin-socket"
import {
  deviceNumber,
  formatDevicesTable,
  formatRevokeError,
  promptLineDefault,
  resolvePairedTarget,
  type PairingDeviceView,
  type ReadableInputLike,
  type SignalSource,
  type WritableStreamLike,
} from "./headless-cli-format"
import type { ConfirmPromptFn } from "./headless-cli-pair"
import { readOfflineSummary, withOfflineSettings } from "./headless-cli-manage"
import { probeLiveHost } from "./host-lock"

async function loadPairedDevices(
  resolvedProfileDir: string,
  stderr: WritableStreamLike,
): Promise<{
  meta: Awaited<ReturnType<typeof probeLiveHost>>
  devices: PairingDeviceView[]
  desktopClients: DesktopAuthorizedClient[]
} | null> {
  const meta = await probeLiveHost(resolvedProfileDir)
  if (!meta) {
    const summary = readOfflineSummary(resolvedProfileDir)
    return { meta: null, devices: summary.devices, desktopClients: summary.desktopClients }
  }
  try {
    const [devices, desktopClients] = await Promise.all([
      callAdminSocket(meta.socketPath, "mobile.devices.list", {}),
      callAdminSocket(meta.socketPath, "desktop.devices.list", {}),
    ])
    return { meta, devices, desktopClients }
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
      `${JSON.stringify({
        running: Boolean(loaded.meta),
        profileDir: resolved,
        devices: loaded.devices,
        desktopClients: loaded.desktopClients,
      })}\n`,
    )
  } else {
    stdout.write(`${formatDevicesTable(loaded.devices, loaded.desktopClients)}\n`)
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
    signalSource: SignalSource
    confirmPrompt?: ConfirmPromptFn | undefined
  },
): Promise<number> {
  const { stdout, stderr, stdin, env, signalSource } = deps
  const resolved = resolve(profileDir)
  const loaded = await loadPairedDevices(resolved, stderr)
  if (!loaded) return 1

  const targetResult = resolvePairedTarget(loaded.devices, loaded.desktopClients, idOrPrefix)
  if (!targetResult.ok) {
    if (targetResult.reason === "missing") {
      stderr.write(`未找到匹配的已配对设备: ${idOrPrefix}\n`)
    } else {
      const candidates = targetResult.matches
        .map((entry) => {
          const item = entry.role === "mobile" ? entry.device : entry.client
          return `${deviceNumber(item.id)} (${item.name})`
        })
        .join(", ")
      stderr.write(`匹配到多个已配对设备，请使用更精确的编号前缀: ${candidates}\n`)
    }
    return 1
  }

  const targetEntry = targetResult.entry
  const target = targetEntry.role === "mobile" ? targetEntry.device : targetEntry.client
  if (!yes) {
    if (!stdin.isTTY) {
      stderr.write("非交互终端下撤销配对需要传入 --yes 参数确认。\n")
      return 2
    }
    const controller = new AbortController()
    let interrupted = false
    const onSigInt = (): void => {
      interrupted = true
      controller.abort()
    }
    signalSource.on("SIGINT", onSigInt)
    let answer: string | null
    try {
      const prompt = `确认撤销「${target.name}」（设备编号 ${deviceNumber(target.id)}）的授权？[y/N] `
      answer = deps.confirmPrompt
        ? await deps.confirmPrompt({ prompt, signal: controller.signal })
        : await promptLineDefault(json ? "" : prompt, stdin, stdout, controller.signal)
    } finally {
      signalSource.off("SIGINT", onSigInt)
    }
    if (interrupted) {
      stderr.write("已取消撤销配对。\n")
      return 130
    }
    const normalized = answer?.trim().toLowerCase() ?? ""
    if (normalized !== "y" && normalized !== "yes") {
      stderr.write("已取消撤销配对。\n")
      return 1
    }
  }

  // 在确认完成之后重新探测存活 Host，消除输入等待期间 Host 启停带来的 TOCTOU。
  const liveMeta = await probeLiveHost(resolved)
  let revokeResult: {
    status: "revoked" | "missing-device" | "storage-unavailable"
    pairing: unknown
  }
  if (liveMeta) {
    try {
      revokeResult =
        targetEntry.role === "desktop"
          ? await callAdminSocket(liveMeta.socketPath, "desktop.devices.revoke", {
              deviceId: target.id,
            })
          : await callAdminSocket(liveMeta.socketPath, "mobile.devices.revoke", {
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
      const offlineView = () =>
        targetEntry.role === "desktop"
          ? { status: "idle" as const, attempt: null, clients: paired.desktopView(new Set()) }
          : {
              status: "idle" as const,
              attempt: null,
              devices: paired.view(relay.revision, new Set()),
            }
      const found = paired.findById(target.id, targetEntry.role)
      if (!found) {
        return { status: "missing-device", pairing: offlineView() }
      }
      try {
        paired.remove(found)
      } catch {
        return { status: "storage-unavailable", pairing: offlineView() }
      }
      return { status: "revoked", pairing: offlineView() }
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
