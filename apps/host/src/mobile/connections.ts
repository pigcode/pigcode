import { mobileFrames } from "./mobile-frames"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { hostname } from "node:os"
import {
  deviceHandshakeSchema,
  mobileFeatures,
  mobileHelloSchema,
  mobileProtocolVersion,
  publicKeySchema,
  type MobilePairingView,
  type MobileRevokeResult,
  type PairedDevice,
} from "@pigcode/contracts"
import type { RelayCredentialCipher, RelaySettings } from "../services/relay-settings"
import type { Context } from "cordis"
import type { ThreadFeed } from "../rpc/thread-feed"
import { acceptNoise, noiseKeyPair, type NoiseKeyPair, type NoiseSession } from "./noise"
import { fingerprint, PairedDevices } from "./paired-devices"
import { pairingAttemptView, type Attempt } from "./pairing-attempt"
import { openRelayHost, type RelayHost } from "./relay-host"
import { serveMobileSidebar } from "./sidebar-rpc"

const validity = 180_000
const identityKey = "mobile.identity"
type Status = MobilePairingView["status"]

interface Peer {
  phase: "handshake" | "proof" | "approval" | "hello" | "ready"
  timer?: ReturnType<typeof setTimeout>
  noise?: NoiseSession
  device?: PairedDevice | undefined
  attempt?: Attempt | undefined
  rpc?: ReturnType<typeof serveMobileSidebar>
}

declare module "cordis" {
  interface Context {
    mobileConnections: MobileConnections
  }
}

export class MobileConnections {
  private readonly computerName = hostname().split(".")[0]?.slice(0, 80) || "Pigcode"
  private peers = new Map<number, Peer>()
  private readonly devices: PairedDevices
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
    private readonly ctx: Context,
    private readonly relay: RelaySettings,
    private readonly cipher: RelayCredentialCipher,
    private readonly feed: ThreadFeed,
    private readonly now = Date.now,
  ) {
    this.devices = new PairedDevices(ctx.settings)
    this.unsubscribe = relay.onConnectionChange(() => {
      this.finish(this.attempt ? "cancelled" : "idle", false)
      this.disconnect()
      this.scheduleReconnect(0)
    })
    this.scheduleReconnect(0)
  }

  view(): MobilePairingView {
    this.expire()
    const connected = new Set<string>()
    for (const peer of this.peers.values()) {
      if (peer.phase === "ready" && peer.device) connected.add(peer.device.publicKey)
    }
    return {
      status: this.status,
      attempt: pairingAttemptView(this.attempt),
      devices: this.devices.view(this.relay.revision, connected),
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
    const revision = this.relay.revision
    const device = this.devices.find(peer.device.publicKey) ?? peer.device
    try {
      this.devices.save({ ...device, confirmedRelayRevision: revision })
    } catch {
      this.dropPeer(candidate.session, true)
      this.finish("storage-unavailable")
      return this.view()
    }
    peer.attempt = undefined
    peer.phase = "hello"
    this.armPeer(candidate.session, peer)
    try {
      this.send(candidate.session, peer, { type: "device.approved", relayRevision: revision })
    } catch {
      this.dropPeer(candidate.session, true)
    }
    this.finish(candidate.mode === "update" ? "update-approved" : "paired")
    return this.view()
  }

  revoke(deviceId: string): MobileRevokeResult {
    const device = this.devices.findById(deviceId)
    if (!device) return { status: "missing-device", pairing: this.view() }

    try {
      this.devices.remove(device)
    } catch {
      return { status: "storage-unavailable", pairing: this.view() }
    }

    let cancelAttempt = false
    for (const [session, peer] of this.peers) {
      if (peer.device?.publicKey !== device.publicKey) continue
      cancelAttempt ||= peer.attempt !== undefined && peer.attempt === this.attempt
      this.dropPeer(session, true)
    }
    if (this.devices.size === 0 || cancelAttempt) this.finish(this.attempt ? "cancelled" : "idle")
    this.ctx.agents.cancelDeviceQueuedRuns(device.publicKey)
    return { status: "revoked", pairing: this.view() }
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
    if (closeIdle && this.devices.size === 0) this.disconnect()
  }

  private computerIdentity(): Promise<NoiseKeyPair> {
    this.identity ??= this.loadIdentity().catch((error: unknown) => {
      this.identity = undefined
      throw error
    })
    return this.identity
  }

  private async loadIdentity(): Promise<NoiseKeyPair> {
    const sealed = this.ctx.settings.get(identityKey)
    if (typeof sealed === "string") {
      const seed = publicKeySchema.parse(await this.cipher.open(sealed))
      return noiseKeyPair(Buffer.from(seed, "base64url"))
    }
    if (sealed !== undefined || this.devices.size > 0)
      throw new Error("computer identity unavailable")
    const identity = noiseKeyPair()
    this.ctx.settings.set(identityKey, await this.cipher.seal(identity.seed.toString("base64url")))
    return identity
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
    if (this.disposed || this.retry || this.devices.size === 0) return
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
    peer.rpc?.close()
    if (this.attempt?.candidate?.session === session) {
      this.attempt.candidate = null
      this.status = "waiting"
    }
    if (close) this.connection?.closeSession(session)
  }

  private send(session: number, peer: Peer, message: unknown): void {
    if (!peer.noise || !this.connection) throw new Error("mobile session closed")
    for (const frame of mobileFrames(message)) {
      this.connection.send(session, peer.noise.encrypt(frame))
    }
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
          this.negotiate(identity, session, peer, message)
          break
        case "ready":
          peer.rpc?.receive(message)
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
    const registered = this.devices.find(publicKey)
    if (request.type === "device.connect") {
      if (!registered) throw new Error("unpaired device")
      peer.device = registered
      peer.phase = "hello"
    } else {
      const attempt = this.attempt
      const supplied = Buffer.from(request.secret, "base64url")
      if (!attempt?.qr || supplied.length !== 32 || !timingSafeEqual(attempt.secret, supplied)) {
        throw new Error("unknown pairing attempt")
      }
      let device = registered
      if (!device) {
        if (request.type !== "device.pair") throw new Error("unpaired device")
        device = {
          name: request.name,
          platform: request.platform,
          publicKey,
          lastConnectedAt: null,
        }
      }
      peer.device = device
      peer.attempt = attempt
      peer.phase = "proof"
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
      mode: this.devices.find(peer.device.publicKey) ? "update" : "pair",
    }
    this.send(session, peer, { type: "device.check" })
    this.status = "verify"
  }

  private negotiate(identity: NoiseKeyPair, session: number, peer: Peer, message: unknown): void {
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
    const device = peer.device && this.devices.find(peer.device.publicKey)
    if (!device) throw new Error("device not authorized")
    const features = mobileFeatures.filter((feature) => hello.features.includes(feature))
    peer.device = { ...device, lastConnectedAt: this.now() }
    this.devices.save(peer.device)
    peer.rpc = serveMobileSidebar(
      this.ctx,
      this.feed,
      this.devices,
      {
        computerKey: identity.publicKey,
        computerName: this.computerName,
        deviceKey: device.publicKey,
        features,
        relayRevision: () => this.relay.revision,
      },
      (message) => this.send(session, peer, message),
    )
    peer.phase = "ready"
    clearTimeout(peer.timer)
    this.send(session, peer, {
      type: "mobile.welcome",
      version: mobileProtocolVersion,
      features,
      computerName: this.computerName,
    })
  }
}
