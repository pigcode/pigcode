/** `pigcode-host` 输出格式化、设备目标匹配与交互式标准输入辅助函数。 */
import { createInterface } from "node:readline/promises"
import type {
  HostRuntimeKind,
  HostStatusView,
  MobilePairingView,
  MobileRevokeResult,
  RelaySettingsView,
  RelayTestResult,
} from "@pigcode/contracts"

export interface WritableStreamLike {
  write(chunk: string): unknown
}

export interface ReadableInputLike extends NodeJS.ReadableStream {
  isTTY?: boolean | undefined
  isRaw?: boolean | undefined
  setRawMode?: ((mode: boolean) => unknown) | undefined
}

export interface SignalSource {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown
}

export type PairingDeviceView = MobilePairingView["devices"][number]

export function deviceNumber(id: string): string {
  return id.slice(0, 8).toUpperCase()
}

export function formatRuntimeLabel(runtime: HostRuntimeKind): string {
  return runtime === "desktop" ? "桌面端 (desktop)" : "无窗口服务 (headless)"
}

export function formatRelayLine(relay: RelaySettingsView): string {
  if (!relay.tokenConfigured || !relay.address) return "未配置"
  return `已配置 (${relay.address})`
}

export function formatStartSummary(info: {
  profileDir: string
  pid: number
  socketPath: string
  lanAddresses: string[]
  lanPort: number | false | undefined
  relay: RelaySettingsView
}): string {
  const lanText =
    info.lanPort === false
      ? "已禁用"
      : info.lanAddresses.length > 0
        ? info.lanAddresses.join(", ")
        : "暂无可用地址"
  return [
    "Pigcode Host 已启动（无窗口常驻模式）",
    `配置目录: ${info.profileDir}`,
    `进程 PID: ${info.pid}`,
    `控制通道: ${info.socketPath}`,
    `局域网地址: ${lanText}`,
    `中继状态: ${formatRelayLine(info.relay)}`,
  ].join("\n")
}

export function formatHostStatus(status: HostStatusView): string {
  return [
    "Host 状态: 运行中",
    `运行模式: ${formatRuntimeLabel(status.runtime)}`,
    `进程 PID: ${status.pid}`,
    `版本: ${status.version}`,
    `配置目录: ${status.profileDir}`,
    `中继状态: ${formatRelayLine(status.relay)}`,
    `局域网地址: ${status.lanAddresses.length > 0 ? status.lanAddresses.join(", ") : "无"}`,
    `活跃 run: ${status.activeRuns}`,
    `待审批: ${status.pendingApprovals}`,
    `已配对设备: ${status.pairedDevices}`,
  ].join("\n")
}

export function formatOfflineStatus(
  profileDir: string,
  relay: RelaySettingsView,
  pairedDevices: number,
): string {
  return [
    "Host 未运行",
    `配置目录: ${profileDir}`,
    `中继状态: ${formatRelayLine(relay)}`,
    `已配对设备: ${pairedDevices}`,
  ].join("\n")
}

export function formatRelayStatus(view: RelaySettingsView, running: boolean): string {
  return [
    `Host 状态: ${running ? "运行中" : "未运行"}`,
    `中继状态: ${view.tokenConfigured ? "已配置" : "未配置"}`,
    `中继地址: ${view.address ?? "无"}`,
    `访问令牌: ${view.tokenConfigured ? "已配置" : "未配置"}`,
  ].join("\n")
}

export function formatRelayError(status: Exclude<RelayTestResult["status"], "saved">): string {
  switch (status) {
    case "invalid-address":
      return "请输入有效的 wss:// 中继地址。"
    case "token-required":
      return "请填写中继访问令牌。"
    case "token-rejected":
      return "中继拒绝了访问令牌，请检查后重试。"
    case "unreachable":
      return "连不上中继，请检查地址、网络和证书。"
    case "incompatible":
      return "中继的探测协议不兼容，请检查中继版本。"
    case "storage-unavailable":
      return "本机凭据密钥不可用，配置未保存。"
    case "busy":
      return "已有中继测试正在进行。"
  }
}

export function formatPairingError(status: string): string {
  switch (status) {
    case "needs-relay":
      return "请先测试并保存中继配置（可运行 pigcode-host relay set --address <wss://...>）。"
    case "relay-unavailable":
      return "配对时连不上中继，请检查中继配置和版本。"
    case "qr-unavailable":
      return "二维码生成失败，请缩短中继地址或令牌后重试。"
    case "storage-unavailable":
      return "本机凭据密钥不可用，无法完成配对。"
    case "expired":
      return "二维码已过期，请重新生成。"
    case "cancelled":
      return "配对已取消。"
    case "disconnected":
      return "手机端连接已断开，配对核对已取消。"
    case "superseded":
      return "当前配对会话已被新的配对操作取代，已取消。"
    case "host-unavailable":
      return "与本机 Host 控制通道断开连接。"
    default:
      return `配对未能完成（状态: ${status}）。`
  }
}

export function formatRevokeError(
  status: Exclude<MobileRevokeResult["status"], "revoked">,
): string {
  switch (status) {
    case "missing-device":
      return "该设备已从配对清单移除。"
    case "storage-unavailable":
      return "无法保存撤销结果，请重试。"
  }
}

export function formatDevicesTable(devices: readonly PairingDeviceView[]): string {
  if (devices.length === 0) return "还没有已配对设备。"
  const rows = devices.map((device) => {
    const number = deviceNumber(device.id)
    const platform = device.platform === "ios" ? "iOS" : "Android"
    const state = device.connected
      ? device.needsRelayUpdate
        ? "已连接（待更新中继）"
        : "已连接"
      : device.needsRelayUpdate
        ? "未连接（待更新中继）"
        : "未连接"
    const lastConnected =
      device.lastConnectedAt === null
        ? "尚未成功连接"
        : new Date(device.lastConnectedAt).toLocaleString()
    const apns = device.pushRegistered ? "APNs 已登记" : "推送未登记"
    return `${number}\t${device.name}\t${platform}\t${state}\t${lastConnected}\t${apns}`
  })
  return ["设备编号\t名称\t平台\t状态\t最近连接时间\tAPNs 状态", ...rows].join("\n")
}

export type ResolveDeviceResult =
  | { ok: true; device: PairingDeviceView }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "ambiguous"; matches: PairingDeviceView[] }

/** 按完整 ID、ID 前缀（不区分大小写）或唯一精确名称解析已配对设备。 */
export function resolveDeviceTarget(
  devices: readonly PairingDeviceView[],
  idOrPrefix: string,
): ResolveDeviceResult {
  const query = idOrPrefix.trim()
  if (!query) return { ok: false, reason: "missing" }
  const lower = query.toLowerCase()

  const exactId = devices.find((device) => device.id.toLowerCase() === lower)
  if (exactId) return { ok: true, device: exactId }

  const combined = new Map<string, PairingDeviceView>()
  for (const device of devices) {
    if (device.id.toLowerCase().startsWith(lower) || device.name === query) {
      combined.set(device.id, device)
    }
  }
  const matches = [...combined.values()]
  if (matches.length === 0) return { ok: false, reason: "missing" }
  if (matches.length === 1) return { ok: true, device: matches[0]! }
  return { ok: false, reason: "ambiguous", matches }
}

const DEFAULT_MAX_STDIN_BYTES = 16_384

/** 读取 stdin 全量文本（带字节上限保护）并裁掉末尾换行。 */
export async function readAllStdin(
  stdin: ReadableInputLike,
  maxBytes: number = DEFAULT_MAX_STDIN_BYTES,
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false
    const cleanup = (): void => {
      stdin.off("data", onData)
      stdin.off("end", onEnd)
      stdin.off("error", onError)
    }
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      stdin.pause()
      rejectPromise(error)
    }
    const onData = (chunk: string | Buffer): void => {
      if (settled) return
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk
      totalBytes += buf.length
      if (totalBytes > maxBytes) {
        fail(new Error(`标准输入内容超过 ${maxBytes} 字节上限`))
        return
      }
      chunks.push(buf)
    }
    const onEnd = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolvePromise(
        Buffer.concat(chunks)
          .toString("utf8")
          .replace(/(?:\r?\n)+$/, ""),
      )
    }
    const onError = (error: Error): void => fail(error)
    stdin.on("data", onData)
    stdin.once("end", onEnd)
    stdin.once("error", onError)
    stdin.resume()
  })
}

type EscState = "none" | "esc" | "csi" | "ss3"

/** 从 TTY raw 模式无回显读取密码/令牌；不支持 raw 模式时直接拒绝，防止明文回显。 */
export async function readHiddenInputDefault(
  prompt: string,
  stdin: ReadableInputLike,
  promptOut: WritableStreamLike,
  signalSource: SignalSource = process,
): Promise<string | null> {
  if (typeof stdin.setRawMode !== "function") {
    throw new Error("当前终端不支持隐藏输入，请改用 --token-stdin")
  }

  promptOut.write(prompt)
  const wasRaw = stdin.isRaw ?? false
  stdin.setRawMode(true)
  stdin.resume()

  return new Promise((resolveInput) => {
    const chars: string[] = []
    let escState: EscState = "none"
    let settled = false
    let cleanupDone = false

    const restoreTerminal = (): void => {
      if (cleanupDone) return
      cleanupDone = true
      stdin.off("data", onData)
      stdin.off("end", onEnd)
      stdin.off("close", onClose)
      stdin.off("error", onError)
      signalSource.off("SIGINT", onSignal)
      signalSource.off("SIGTERM", onSignal)
      try {
        stdin.setRawMode?.(wasRaw)
      } catch {
        // 忽略恢复终端模式时的异常。
      }
      try {
        stdin.pause()
      } catch {
        // 忽略暂停流时的异常。
      }
    }

    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      try {
        restoreTerminal()
      } finally {
        promptOut.write("\n")
        resolveInput(value)
      }
    }

    const onSignal = (): void => finish(null)
    const onEnd = (): void => finish(null)
    const onClose = (): void => finish(null)
    const onError = (): void => finish(null)

    const onData = (chunk: string | Buffer): void => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8")
      for (const ch of text) {
        if (ch === "\u0003") {
          finish(null)
          return
        }
        if (escState === "esc") {
          if (ch === "[") escState = "csi"
          else if (ch === "O") escState = "ss3"
          else escState = "none"
          continue
        }
        if (escState === "csi") {
          const code = ch.codePointAt(0) ?? 0
          if (code >= 0x20 && code <= 0x3f) continue
          if (code >= 0x40 && code <= 0x7e) {
            escState = "none"
            continue
          }
          escState = "none"
        } else if (escState === "ss3") {
          escState = "none"
          continue
        }

        if (ch === "\x1b") {
          escState = "esc"
          continue
        }
        if (ch === "\u0004") {
          finish(chars.length > 0 ? chars.join("") : null)
          return
        }
        if (ch === "\r" || ch === "\n") {
          finish(chars.join(""))
          return
        }
        if (ch === "\u007f" || ch === "\b") {
          chars.pop()
          continue
        }
        const code = ch.codePointAt(0) ?? 0
        if (code >= 32) {
          chars.push(ch)
        }
      }
    }

    stdin.on("data", onData)
    stdin.once("end", onEnd)
    stdin.once("close", onClose)
    stdin.once("error", onError)
    signalSource.on("SIGINT", onSignal)
    signalSource.on("SIGTERM", onSignal)
  })
}

/** 读取单行确认输入，支持 `AbortSignal` 立即中止等待。 */
export async function promptLineDefault(
  prompt: string,
  stdin: ReadableInputLike,
  promptOut: WritableStreamLike,
  signal?: AbortSignal,
): Promise<string | null> {
  if (signal?.aborted) return null
  if (prompt) promptOut.write(prompt)
  const rl = createInterface({ input: stdin, terminal: false })
  const onAbort = (): void => {
    rl.close()
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    return signal ? await rl.question("", { signal }) : await rl.question("")
  } catch {
    return null
  } finally {
    signal?.removeEventListener("abort", onAbort)
    rl.close()
    if (stdin === process.stdin) stdin.pause?.()
  }
}
