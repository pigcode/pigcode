/**
 * 远程主机出站 Noise IK 客户端传输层：
 * 支持局域网 WS 直连与自建 Go 中继（`relay.phone`）透明切换与分片 RPC 收发。
 */
import { createHash } from "node:crypto"
import {
  DESKTOP_RPC_MAX_BYTES,
  RELAY_PROTOCOL_VERSION,
  desktopProtocolVersion,
  desktopWelcomeSchema,
  relayAdmissionSchema,
  type DesktopPairingPayload,
  type DesktopPlatform,
  type DesktopWelcome,
  type HostChannel,
  type HostRuntimeKind,
} from "@pigcode/contracts"
import { FrameAssembler, mobileFrames } from "@pigcode/host/mobile/mobile-frames"
import { beginNoise, type NoiseKeyPair, type NoiseSession } from "@pigcode/host/mobile/noise"

const HANDSHAKE_TIMEOUT_MS = 10_000

export type RemoteConnectErrorCode =
  | "offline"
  | "busy"
  | "token-rejected"
  | "incompatible"
  | "revoked"
  | "unreachable"
  | "aborted"
  | "pairing-rejected"

export class RemoteConnectError extends Error {
  constructor(
    readonly code: RemoteConnectErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "RemoteConnectError"
  }
}

export interface RemoteNoiseSession {
  readonly channel: Exclude<HostChannel, "local">
  readonly latencyMs: number
  readonly hostKey: string
  readonly hostName: string
  readonly runtime: HostRuntimeKind
  readonly lanAddresses: string[]
  send(message: unknown): void
  onMessage(listener: (message: unknown) => void): () => void
  onClose(listener: (reason: "closed" | "revoked") => void): () => void
  close(): void
}

function sha256Hex(publicKey: Buffer): string {
  return createHash("sha256").update(publicKey).digest("hex")
}

interface RawWsChannel {
  readonly channel: "lan" | "relay"
  readonly url: string
  sendBinary(bytes: Buffer): void
  nextBinary(signal: AbortSignal): Promise<Buffer>
  onBinary(handler: (bytes: Buffer) => void): void
  onClosed(handler: () => void): void
  close(): void
}

async function openRawWebSocket(
  url: string,
  channel: "lan" | "relay",
  signal: AbortSignal,
  relayJoin?: { computerId: string; token: string },
): Promise<RawWsChannel> {
  if (signal.aborted) throw new RemoteConnectError("aborted", "connection aborted")
  const ws = new WebSocket(url)
  ws.binaryType = "arraybuffer"

  const queue: Buffer[] = []
  const waiters: Array<{ resolve: (b: Buffer) => void; reject: (e: Error) => void }> = []
  let activeBinaryHandler: ((b: Buffer) => void) | undefined
  let activeCloseHandler: (() => void) | undefined
  let closed = false

  const closeSocket = () => {
    if (closed) return
    closed = true
    while (waiters.length > 0) {
      waiters.shift()!.reject(new RemoteConnectError("unreachable", "socket closed"))
    }
    try {
      ws.close()
    } catch {
      // ignore close errors
    }
    activeCloseHandler?.()
  }

  const onAbort = () => closeSocket()
  signal.addEventListener("abort", onAbort, { once: true })

  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => {
      rejectOpen(new RemoteConnectError("unreachable", `timed out connecting to ${url}`))
      closeSocket()
    }, HANDSHAKE_TIMEOUT_MS)

    let joined = !relayJoin

    ws.addEventListener("open", () => {
      if (!relayJoin) {
        clearTimeout(timer)
        resolveOpen()
        return
      }
      ws.send(
        JSON.stringify({
          type: "relay.phone",
          version: RELAY_PROTOCOL_VERSION,
          computerId: relayJoin.computerId,
          token: relayJoin.token,
        }),
      )
    })

    ws.addEventListener("message", ({ data }) => {
      if (closed) return
      if (!joined && typeof data === "string") {
        clearTimeout(timer)
        try {
          const admission = relayAdmissionSchema.parse(JSON.parse(data))
          if (admission.status !== "ok") {
            const code =
              admission.status === "offline"
                ? "offline"
                : admission.status === "busy"
                  ? "busy"
                  : admission.status === "token-rejected"
                    ? "token-rejected"
                    : "incompatible"
            rejectOpen(new RemoteConnectError(code, `relay rejected client: ${admission.status}`))
            closeSocket()
            return
          }
          joined = true
          resolveOpen()
        } catch (error) {
          rejectOpen(
            error instanceof Error
              ? error
              : new RemoteConnectError("incompatible", "invalid relay admission"),
          )
          closeSocket()
        }
        return
      }

      if (data instanceof ArrayBuffer) {
        const buf = Buffer.from(data)
        if (activeBinaryHandler) {
          activeBinaryHandler(buf)
          return
        }
        const waiter = waiters.shift()
        if (waiter) waiter.resolve(buf)
        else queue.push(buf)
      }
    })

    ws.addEventListener("error", () => {
      clearTimeout(timer)
      if (!joined) rejectOpen(new RemoteConnectError("unreachable", `failed connecting to ${url}`))
      closeSocket()
    })

    ws.addEventListener("close", () => {
      clearTimeout(timer)
      if (!joined) rejectOpen(new RemoteConnectError("offline", `relay connection closed`))
      closeSocket()
    })
  }).finally(() => {
    signal.removeEventListener("abort", onAbort)
  })

  return {
    channel,
    url,
    sendBinary(bytes) {
      if (!closed && ws.readyState === WebSocket.OPEN) ws.send(bytes)
    },
    nextBinary(waitSignal) {
      const immediate = queue.shift()
      if (immediate) return Promise.resolve(immediate)
      if (closed) return Promise.reject(new RemoteConnectError("unreachable", "socket closed"))
      if (waitSignal.aborted) return Promise.reject(new RemoteConnectError("aborted", "aborted"))
      return new Promise<Buffer>((resolveBuf, rejectBuf) => {
        const entry = {
          resolve: (buf: Buffer) => {
            waitSignal.removeEventListener("abort", abortWait)
            resolveBuf(buf)
          },
          reject: (err: Error) => {
            waitSignal.removeEventListener("abort", abortWait)
            rejectBuf(err)
          },
        }
        const abortWait = () => {
          const idx = waiters.indexOf(entry)
          if (idx >= 0) waiters.splice(idx, 1)
          rejectBuf(new RemoteConnectError("aborted", "aborted"))
        }
        waitSignal.addEventListener("abort", abortWait, { once: true })
        waiters.push(entry)
      })
    },
    onBinary(handler) {
      activeBinaryHandler = handler
      while (queue.length > 0) handler(queue.shift()!)
    },
    onClosed(handler) {
      activeCloseHandler = handler
      if (closed) handler()
    },
    close: closeSocket,
  }
}

async function readDecryptedJson(
  ws: RawWsChannel,
  noise: NoiseSession,
  assembler: FrameAssembler,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  while (true) {
    const cipher = await ws.nextBinary(signal)
    const plain = noise.decrypt(cipher)
    const res = assembler.push(plain)
    if (res.complete) return res.message as Record<string, unknown>
  }
}

function sendEncryptedJson(ws: RawWsChannel, noise: NoiseSession, message: unknown): void {
  for (const frame of mobileFrames(message, DESKTOP_RPC_MAX_BYTES)) {
    ws.sendBinary(noise.encrypt(frame))
  }
}

function buildLiveSession(
  ws: RawWsChannel,
  noise: NoiseSession,
  assembler: FrameAssembler,
  welcome: DesktopWelcome,
  latencyMs: number,
): RemoteNoiseSession {
  const messageListeners = new Set<(msg: unknown) => void>()
  const closeListeners = new Set<(reason: "closed" | "revoked") => void>()
  let closed = false

  const teardown = (reason: "closed" | "revoked") => {
    if (closed) return
    closed = true
    ws.close()
    for (const listener of [...closeListeners]) listener(reason)
    messageListeners.clear()
    closeListeners.clear()
  }

  ws.onBinary((ciphertext) => {
    if (closed) return
    try {
      const plain = noise.decrypt(ciphertext)
      const assembled = assembler.push(plain)
      if (!assembled.complete) return
      const msg = assembled.message as { type?: string }
      if (msg && typeof msg === "object" && msg.type === "device.revoked") {
        teardown("revoked")
        return
      }
      for (const listener of [...messageListeners]) listener(assembled.message)
    } catch {
      teardown("closed")
    }
  })

  ws.onClosed(() => teardown("closed"))

  return {
    channel: ws.channel,
    latencyMs,
    hostKey: welcome.hostKey,
    hostName: welcome.hostName,
    runtime: welcome.runtime ?? "desktop",
    lanAddresses: welcome.lanAddresses ?? [],
    send(message) {
      if (closed) throw new Error("remote session closed")
      sendEncryptedJson(ws, noise, message)
    },
    onMessage(listener) {
      messageListeners.add(listener)
      return () => messageListeners.delete(listener)
    },
    onClose(listener) {
      closeListeners.add(listener)
      return () => closeListeners.delete(listener)
    },
    close() {
      teardown("closed")
    },
  }
}

interface CandidateAttempt {
  kind: "lan" | "relay"
  url: string
}

function buildCandidates(options: {
  lanAddresses?: readonly string[] | undefined
  relayAddress?: string | null | undefined
  relayToken?: string | null | undefined
}): CandidateAttempt[] {
  const out: CandidateAttempt[] = []
  for (const url of options.lanAddresses ?? []) {
    out.push({ kind: "lan", url })
  }
  if (options.relayAddress && options.relayToken) {
    out.push({ kind: "relay", url: options.relayAddress })
  }
  return out
}

async function openFirstReachableChannel(options: {
  lanAddresses?: readonly string[] | undefined
  relayAddress?: string | null | undefined
  relayToken?: string | null | undefined
  hostPub: Buffer
  signal: AbortSignal
}): Promise<RawWsChannel> {
  const candidates = buildCandidates(options)
  if (candidates.length === 0) {
    throw new RemoteConnectError("unreachable", "no LAN or relay address available")
  }
  const computerId = sha256Hex(options.hostPub)
  let lastError: unknown

  // LAN 候选优先快速直连；若失败或超时，再通过中继穿透连接。
  for (const candidate of candidates) {
    if (options.signal.aborted) throw new RemoteConnectError("aborted", "connection aborted")
    try {
      return await openRawWebSocket(
        candidate.url,
        candidate.kind,
        options.signal,
        candidate.kind === "relay" && options.relayToken
          ? { computerId, token: options.relayToken }
          : undefined,
      )
    } catch (error) {
      lastError = error
      if (error instanceof RemoteConnectError && error.code === "token-rejected") throw error
    }
  }
  if (lastError instanceof RemoteConnectError) throw lastError
  throw new RemoteConnectError("unreachable", "unable to reach remote host")
}

export async function pairWithRemoteHost(options: {
  payload: DesktopPairingPayload
  clientIdentity: NoiseKeyPair
  localName: string
  localPlatform: DesktopPlatform
  signal: AbortSignal
  onVerify: (verificationCode: string) => void
}): Promise<RemoteNoiseSession> {
  const hostPub = Buffer.from(options.payload.hostKey, "base64url")
  const ws = await openFirstReachableChannel({
    lanAddresses: options.payload.lanAddresses,
    relayAddress: options.payload.address,
    relayToken: options.payload.token,
    hostPub,
    signal: options.signal,
  })

  try {
    const t0 = Date.now()
    const handshake = beginNoise(
      options.clientIdentity,
      hostPub,
      Buffer.from(
        JSON.stringify({
          type: "device.pair",
          role: "desktop",
          secret: options.payload.secret,
          name: options.localName,
          platform: options.localPlatform,
        }),
      ),
    )
    ws.sendBinary(handshake.message)
    const reply = await ws.nextBinary(options.signal)
    const { session: noise } = handshake.finish(reply)
    const assembler = new FrameAssembler(DESKTOP_RPC_MAX_BYTES)

    sendEncryptedJson(ws, noise, { type: "device.confirm" })
    const checkMsg = await readDecryptedJson(ws, noise, assembler, options.signal)
    if (checkMsg.type !== "device.check") {
      throw new RemoteConnectError("pairing-rejected", "unexpected pairing check frame")
    }
    options.onVerify(noise.verificationCode)

    // 允许用户在远端主机确认 6 位验证码（最多等待口令本身有效期 / 连接关闭）。
    const approveDeadline = AbortSignal.any([options.signal, AbortSignal.timeout(180_000)])
    const approvedMsg = await readDecryptedJson(ws, noise, assembler, approveDeadline)
    if (approvedMsg.type !== "device.approved") {
      throw new RemoteConnectError("pairing-rejected", "pairing approval rejected")
    }

    sendEncryptedJson(ws, noise, {
      type: "desktop.hello",
      minVersion: desktopProtocolVersion,
      maxVersion: desktopProtocolVersion,
    })
    const welcomeRaw = await readDecryptedJson(ws, noise, assembler, options.signal)
    if (welcomeRaw.type === "desktop.incompatible") {
      throw new RemoteConnectError("incompatible", "desktop protocol version mismatch")
    }
    const welcome = desktopWelcomeSchema.parse(welcomeRaw)
    const latencyMs = Math.max(1, Date.now() - t0)
    return buildLiveSession(ws, noise, assembler, welcome, latencyMs)
  } catch (error) {
    ws.close()
    throw error
  }
}

export async function connectSavedRemoteHost(options: {
  hostKey: string
  lanAddresses: readonly string[]
  relayAddress: string | null
  relayToken: string | null
  clientIdentity: NoiseKeyPair
  signal: AbortSignal
}): Promise<RemoteNoiseSession> {
  const hostPub = Buffer.from(options.hostKey, "base64url")
  const ws = await openFirstReachableChannel({
    lanAddresses: options.lanAddresses,
    relayAddress: options.relayAddress,
    relayToken: options.relayToken,
    hostPub,
    signal: options.signal,
  })

  try {
    const t0 = Date.now()
    const handshake = beginNoise(
      options.clientIdentity,
      hostPub,
      Buffer.from(JSON.stringify({ type: "device.connect", revocationNotice: true })),
    )
    ws.sendBinary(handshake.message)
    const reply = await ws.nextBinary(options.signal)
    const finished = handshake.finish(reply)
    if (finished.payload.length > 0) {
      const denial = JSON.parse(finished.payload.toString("utf8")) as { type?: string }
      if (denial.type === "device.revoked") {
        throw new RemoteConnectError("revoked", "this desktop client was revoked by remote host")
      }
    }
    const noise = finished.session
    const assembler = new FrameAssembler(DESKTOP_RPC_MAX_BYTES)
    sendEncryptedJson(ws, noise, {
      type: "desktop.hello",
      minVersion: desktopProtocolVersion,
      maxVersion: desktopProtocolVersion,
    })
    const welcomeRaw = await readDecryptedJson(ws, noise, assembler, options.signal)
    if (welcomeRaw.type === "desktop.incompatible") {
      throw new RemoteConnectError("incompatible", "desktop protocol version mismatch")
    }
    const welcome = desktopWelcomeSchema.parse(welcomeRaw)
    const latencyMs = Math.max(1, Date.now() - t0)
    return buildLiveSession(ws, noise, assembler, welcome, latencyMs)
  } catch (error) {
    ws.close()
    throw error
  }
}
