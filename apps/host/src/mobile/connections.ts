import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { hostname } from "node:os"
import {
  deviceHandshakeSchema,
  mobileFeatures,
  mobileHelloSchema,
  mobileProtocolVersion,
  pairedDeviceSchema,
  parseRpcRequest,
  publicKeySchema,
  type MobilePairingView,
  type PairedDevice,
} from "@pigcode/contracts"
import type { RelayCredentialCipher, RelaySettings } from "../services/relay-settings"
import type { SettingsService } from "../services/settings"
import { acceptNoise, noiseKeyPair, type NoiseKeyPair, type NoiseSession } from "./noise"
import { openRelayHost, type RelayHost } from "./relay-host"

const validity = 180_000
const identityKey = "mobile.identity"
const devicesKey = "mobile.devices"
const recordSchema = pairedDeviceSchema.array()
type Status = MobilePairingView["status"]
type Candidate = NonNullable<NonNullable<MobilePairingView["attempt"]>["candidate"]>

interface Attempt {
  id: string
  expiresAt: number
  secret: Buffer
  timer: ReturnType<typeof setTimeout>
  qr: string | null
  candidate: (Candidate & { session: number }) | null
}

interface Peer {
  phase: "handshake" | "proof" | "approval" | "hello" | "ready"
  timer?: ReturnType<typeof setTimeout>
  noise?: NoiseSession
  device?: PairedDevice | undefined
  attempt?: Attempt | undefined
  canReadStatus?: boolean
}

declare module "cordis" {
  interface Context {
    mobileConnections: MobileConnections
  }
}

function fingerprint(publicKey: Buffer): string {
  return createHash("sha256").update(publicKey).digest("hex")
}

export class MobileConnections {
  private readonly computerName = hostname().split(".")[0]?.slice(0, 80) || "Pigcode"
  private peers = new Map<number, Peer>()
  private devices: PairedDevice[]
  private status: Status = "idle"
  private attempt: Attempt | undefined
  private identity: Promise<NoiseKeyPair> | undefined
  private connection: RelayHost | undefined
  private opening: Promise<RelayHost> | undefined
  private registration: AbortController | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private disposed = false
  private unsubscribe: () => void

  constructor(
    private readonly settings: SettingsService,
    private readonly relay: RelaySettings,
    private readonly cipher: RelayCredentialCipher,
    private readonly now = Date.now,
  ) {
    const records = recordSchema.safeParse(settings.get(devicesKey))
    this.devices = records.success ? records.data : []
    this.unsubscribe = relay.onConnectionChange(() => {
      this.finish("cancelled")
      this.disconnect()
      this.scheduleReconnect(0)
    })
    this.scheduleReconnect(0)
  }

  view(): MobilePairingView {
    this.expire()
    const attempt = this.attempt
    return {
      status: this.status,
      attempt: attempt
        ? {
            id: attempt.id,
            expiresAt: attempt.expiresAt,
            qr: attempt.qr,
            candidate: attempt.candidate
              ? {
                  confirmation: attempt.candidate.confirmation,
                  code: attempt.candidate.code,
                  name: attempt.candidate.name,
                }
              : null,
          }
        : null,
      devices: this.devices.map(({ publicKey, ...details }) => ({
        ...details,
        id: fingerprint(Buffer.from(publicKey, "base64url")),
        connected: [...this.peers.values()].some(
          (peer) => peer.phase === "ready" && peer.device?.publicKey === publicKey,
        ),
      })),
    }
  }

  async start(): Promise<MobilePairingView> {
    this.finish("cancelled", false)
    if (!this.relay.view().tokenConfigured) {
      this.finish("needs-relay")
      return this.view()
    }
    const attempt: Attempt = {
      id: randomUUID(),
      expiresAt: this.now() + validity,
      secret: randomBytes(32),
      timer: setTimeout(() => this.expire(), validity).unref(),
      qr: null,
      candidate: null,
    }
    this.attempt = attempt
    this.status = "connecting"
    try {
      const [identity, config] = await Promise.all([
        this.computerIdentity(),
        this.relay.connectionConfig(),
      ])
      if (this.attempt !== attempt) return this.view()
      if (!config) {
        this.finish("needs-relay")
        return this.view()
      }
      const qr = JSON.stringify({
        type: "pigcode.pair",
        version: 1,
        address: config.address,
        token: config.token,
        computerKey: identity.publicKey.toString("base64url"),
        computerName: this.computerName,
        secret: attempt.secret.toString("base64url"),
        expiresAt: attempt.expiresAt,
      })
      if (Buffer.byteLength(qr) > 2953) {
        this.finish("qr-unavailable")
        return this.view()
      }
      try {
        await this.ensureRelay(identity, config)
      } catch {
        if (this.attempt === attempt) this.finish("relay-unavailable")
        return this.view()
      }
      if (this.attempt === attempt) {
        attempt.qr = qr
        this.status = "waiting"
      }
    } catch {
      if (this.attempt === attempt) this.finish("storage-unavailable")
    }
    return this.view()
  }

  cancel(id: string): MobilePairingView {
    if (this.attempt?.id === id) this.finish("cancelled")
    return this.view()
  }

  confirm(id: string, confirmation: string): MobilePairingView {
    this.expire()
    const attempt = this.attempt
    const candidate = attempt?.candidate
    if (attempt?.id !== id || !candidate || candidate.confirmation !== confirmation) {
      return this.view()
    }
    const peer = this.peers.get(candidate.session)
    if (peer?.phase !== "approval" || !peer.device || peer.attempt !== attempt) return this.view()
    try {
      this.saveDevice(peer.device)
    } catch {
      this.dropPeer(candidate.session, true)
      this.finish("storage-unavailable")
      return this.view()
    }
    peer.attempt = undefined
    peer.phase = "hello"
    this.armPeer(candidate.session, peer)
    try {
      this.send(candidate.session, peer, { type: "device.approved" })
    } catch {
      this.dropPeer(candidate.session, true)
    }
    this.finish("paired")
    return this.view()
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.finish("cancelled")
    this.disconnect()
  }

  private expire(): void {
    if (this.attempt && this.now() >= this.attempt.expiresAt) this.finish("expired")
  }

  private finish(status: Status, closeIdle = true): void {
    const attempt = this.attempt
    this.attempt = undefined
    this.status = status
    if (attempt) {
      clearTimeout(attempt.timer)
      attempt.secret.fill(0)
      for (const [session, peer] of this.peers) {
        if (peer.attempt === attempt) this.dropPeer(session, true)
      }
    }
    if (closeIdle && this.devices.length === 0) this.disconnect()
  }

  private computerIdentity(): Promise<NoiseKeyPair> {
    this.identity ??= this.loadIdentity().catch((error: unknown) => {
      this.identity = undefined
      throw error
    })
    return this.identity
  }

  private async loadIdentity(): Promise<NoiseKeyPair> {
    const sealed = this.settings.get(identityKey)
    if (typeof sealed === "string") {
      const seed = publicKeySchema.parse(await this.cipher.open(sealed))
      return noiseKeyPair(Buffer.from(seed, "base64url"))
    }
    if (sealed !== undefined || this.devices.length > 0)
      throw new Error("computer identity unavailable")
    const identity = noiseKeyPair()
    this.settings.set(identityKey, await this.cipher.seal(identity.seed.toString("base64url")))
    return identity
  }

  private saveDevice(device: PairedDevice): void {
    const entry = { ...device, lastConnectedAt: this.now() }
    const next = [...this.devices.filter(({ publicKey }) => publicKey !== entry.publicKey), entry]
    this.settings.set(devicesKey, next)
    this.devices = next
  }

  private ensureRelay(
    identity: NoiseKeyPair,
    config: { address: string; token: string },
  ): Promise<RelayHost> {
    if (this.disposed) return Promise.reject(new Error("Host has stopped"))
    if (this.connection) return Promise.resolve(this.connection)
    if (this.opening) return this.opening
    const generation = ++this.generation
    const current = () => generation === this.generation
    const registration = new AbortController()
    this.registration = registration
    this.opening = openRelayHost(
      config,
      fingerprint(identity.publicKey),
      {
        sessionOpened: (session) => {
          if (!current()) return
          const peer: Peer = { phase: "handshake" }
          this.peers.set(session, peer)
          this.armPeer(session, peer)
        },
        sessionClosed: (session) => {
          if (current()) this.dropPeer(session)
        },
        received: (session, ciphertext) => {
          if (current()) this.receive(identity, session, ciphertext)
        },
        disconnected: () => {
          if (!current()) return
          this.disconnect()
          if (this.attempt) this.finish("relay-unavailable")
          this.scheduleReconnect()
        },
      },
      registration.signal,
    )
      .then((connection) => {
        if (!current()) {
          connection.close()
          throw new Error("relay registration superseded")
        }
        this.connection = connection
        return connection
      })
      .finally(() => {
        if (current()) {
          this.opening = undefined
          this.registration = undefined
        }
      })
    return this.opening
  }

  private disconnect(): void {
    ++this.generation
    this.registration?.abort()
    this.registration = undefined
    this.opening = undefined
    const connection = this.connection
    this.connection = undefined
    connection?.close()
    clearTimeout(this.retry)
    this.retry = undefined
    for (const [session] of this.peers) this.dropPeer(session)
  }

  private scheduleReconnect(delay = 2500): void {
    if (this.disposed || this.retry || this.devices.length === 0) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.restoreRelay()
    }, delay).unref()
  }

  private async restoreRelay(): Promise<void> {
    const generation = this.generation
    try {
      const config = await this.relay.connectionConfig()
      if (!config) return
      const identity = await this.computerIdentity()
      if (generation === this.generation) await this.ensureRelay(identity, config)
    } catch {
      this.scheduleReconnect()
    }
  }

  private armPeer(session: number, peer: Peer): void {
    clearTimeout(peer.timer)
    peer.timer = setTimeout(() => this.dropPeer(session, true), 10_000).unref()
  }

  private dropPeer(session: number, close = false): void {
    const peer = this.peers.get(session)
    if (!peer) return
    clearTimeout(peer.timer)
    this.peers.delete(session)
    if (this.attempt?.candidate?.session === session) {
      this.attempt.candidate = null
      this.status = "waiting"
    }
    if (close) this.connection?.closeSession(session)
  }

  private send(session: number, peer: Peer, message: unknown): void {
    if (!peer.noise || !this.connection) throw new Error("mobile session closed")
    this.connection.send(session, peer.noise.encrypt(Buffer.from(JSON.stringify(message))))
  }

  private receive(identity: NoiseKeyPair, session: number, ciphertext: Buffer): void {
    this.expire()
    const peer = this.peers.get(session)
    if (!peer) return
    try {
      if (peer.phase === "handshake") {
        this.authenticate(identity, session, peer, ciphertext)
        return
      }
      if (!peer.noise) throw new Error("missing Noise session")
      const message: unknown = JSON.parse(peer.noise.decrypt(ciphertext).toString("utf8"))
      switch (peer.phase) {
        case "proof":
          this.requestApproval(session, peer, message)
          break
        case "approval":
          this.dropPeer(session, true)
          break
        case "hello":
          this.negotiate(session, peer, message)
          break
        case "ready":
          this.dispatch(identity, session, peer, message)
          break
      }
    } catch {
      this.dropPeer(session, true)
    }
  }

  private authenticate(
    identity: NoiseKeyPair,
    session: number,
    peer: Peer,
    ciphertext: Buffer,
  ): void {
    const handshake = acceptNoise(identity, ciphertext)
    const request = deviceHandshakeSchema.parse(JSON.parse(handshake.payload.toString("utf8")))
    const publicKey = handshake.publicKey.toString("base64url")
    if (request.type === "device.pair") {
      const attempt = this.attempt
      const supplied = Buffer.from(request.secret, "base64url")
      if (!attempt?.qr || supplied.length !== 32 || !timingSafeEqual(attempt.secret, supplied)) {
        throw new Error("unknown pairing attempt")
      }
      peer.attempt = attempt
      peer.device = {
        name: request.name,
        platform: request.platform,
        publicKey,
        lastConnectedAt: this.now(),
      }
      peer.phase = "proof"
    } else {
      peer.device = this.devices.find((device) => device.publicKey === publicKey)
      if (!peer.device) throw new Error("unpaired device")
      peer.phase = "hello"
    }
    const response = handshake.reply()
    peer.noise = response.session
    this.armPeer(session, peer)
    this.connection?.send(session, response.message)
  }

  private requestApproval(session: number, peer: Peer, message: unknown): void {
    const attempt = this.attempt
    if (
      !attempt ||
      peer.attempt !== attempt ||
      attempt.candidate ||
      !peer.noise ||
      !peer.device ||
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "device.confirm"
    ) {
      throw new Error("invalid pairing confirmation")
    }
    clearTimeout(peer.timer)
    peer.phase = "approval"
    attempt.candidate = {
      session,
      confirmation: randomUUID(),
      code: peer.noise.verificationCode,
      name: peer.device.name,
    }
    this.send(session, peer, { type: "device.check" })
    this.status = "verify"
  }

  private negotiate(session: number, peer: Peer, message: unknown): void {
    const hello = mobileHelloSchema.parse(message)
    if (hello.minVersion > mobileProtocolVersion || hello.maxVersion < mobileProtocolVersion) {
      this.send(session, peer, {
        type: "mobile.incompatible",
        minVersion: mobileProtocolVersion,
        maxVersion: mobileProtocolVersion,
      })
      this.dropPeer(session, true)
      return
    }
    if (!peer.device) throw new Error("device not authorized")
    const features = mobileFeatures.filter((feature) => hello.features.includes(feature))
    this.saveDevice(peer.device)
    peer.canReadStatus = features.includes("connection.status")
    peer.phase = "ready"
    clearTimeout(peer.timer)
    this.send(session, peer, {
      type: "mobile.welcome",
      version: mobileProtocolVersion,
      features,
      computerName: this.computerName,
    })
  }

  private dispatch(identity: NoiseKeyPair, session: number, peer: Peer, message: unknown): void {
    const request = parseRpcRequest(message)
    const response = { jsonrpc: "2.0", id: request.id }
    if (request.method === "mobile.status" && peer.device && peer.canReadStatus) {
      this.send(session, peer, {
        ...response,
        result: {
          computerId: fingerprint(identity.publicKey),
          computerName: this.computerName,
          deviceId: fingerprint(Buffer.from(peer.device.publicKey, "base64url")),
        },
      })
    } else {
      this.send(session, peer, {
        ...response,
        error: { code: "METHOD_NOT_AVAILABLE", message: "Method not available", retryable: false },
      })
    }
  }
}
