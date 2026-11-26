import { randomBytes, randomUUID } from "node:crypto"
import { hostname } from "node:os"
import {
  type MobilePairingView,
  type MobileRevokeResult,
} from "@pigcode/contracts"
import type { RelayCredentialCipher, RelaySettings } from "../services/relay-settings"
import type { Context } from "cordis"
import type { ThreadFeed } from "../rpc/thread-feed"
import type { NoiseKeyPair } from "./noise"
import { loadComputerIdentity } from "./computer-identity"
import {
  authenticatePeer,
  negotiatePeer,
  requestPeerApproval,
  sendPeerMessage,
  type Peer,
  type PeerHostContext,
} from "./connections-peer"
import { openLanServer, type LanConnection, type LanServer } from "./lan-server"
import { fingerprint, PairedDevices } from "./paired-devices"
import { pairingAttemptView, pairingQRCode, pairingValidityMs, type Attempt } from "./pairing-attempt"
import { MobilePushReminders } from "./push-reminders"
import { openRelayHost, type RelayHost } from "./relay-host"
import { deviceRevokedNotice, revokeDeviceWork, tellRevokedDevice } from "./revocation"

type Status = MobilePairingView["status"]

export interface MobileConnectionsOptions {
  now?: () => number
  /** 局域网直连监听端口：0 表示临时端口，false 表示不启用局域网直连服务。 */
  lanPort?: number | false
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
  private readonly push: MobilePushReminders
  private readonly now: () => number
  private readonly lanPort: number | null
  private status: Status = "idle"
  private attempt: Attempt | undefined
  private identity: Promise<NoiseKeyPair> | undefined
  private connection: RelayHost | undefined
  private opening: Promise<RelayHost> | undefined
  private registration: AbortController | undefined
  private lanServer: LanServer | undefined
  private lanStarting: Promise<LanServer | undefined> | undefined
  private nextLanSession = 0
  private retry: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private lanGeneration = 0
  private disposed = false
  private suspended = false
  private unsubscribe: () => void

  constructor(
    private readonly ctx: Context,
    private readonly relay: RelaySettings,
    private readonly cipher: RelayCredentialCipher,
    private readonly feed: ThreadFeed,
    nowOrOptions?: (() => number) | MobileConnectionsOptions,
  ) {
    const options =
      typeof nowOrOptions === "function" ? { now: nowOrOptions } : (nowOrOptions ?? {})
    this.now = options.now ?? Date.now
    this.lanPort = options.lanPort === false ? null : (options.lanPort ?? 0)
    this.devices = new PairedDevices(ctx.settings)
    this.push = new MobilePushReminders(ctx, this.devices, cipher, () => this.connection)
    this.unsubscribe = relay.onConnectionChange(() => {
      this.finish(this.attempt ? "cancelled" : "idle", false)
      this.disconnect()
      this.scheduleReconnect(0)
    })
    this.scheduleReconnect(0)
    void this.startLan()
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
      expiresAt: this.now() + pairingValidityMs,
      secret: randomBytes(32),
      timer: setTimeout(() => this.expire(), pairingValidityMs).unref(),
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
      const qr = pairingQRCode(attempt, config, identity.publicKey, this.computerName)
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
      tellRevokedDevice(peer.revocationNotice, () => this.send(session, peer, deviceRevokedNotice))
      this.dropPeer(session, true)
    }
    if (this.devices.size === 0 || cancelAttempt) this.finish(this.attempt ? "cancelled" : "idle")
    revokeDeviceWork(this.ctx, device.publicKey)
    return { status: "revoked", pairing: this.view() }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.finish("cancelled")
    this.disconnect(true)
    this.stopLan()
  }

  announceExit(state: "exited" | "restarting"): void {
    this.connection?.announce(state)
  }

  setSuspended(suspended: boolean): void {
    if (this.disposed || this.suspended === suspended) return
    this.suspended = suspended
    if (suspended) {
      this.connection?.announce("sleeping")
      if (this.attempt) this.finish("cancelled", false)
      this.disconnect(true)
      this.stopLan()
    } else {
      this.disconnect(false)
      this.scheduleReconnect(0)
      void this.startLan()
    }
  }

  /** 返回当前可用的局域网直连地址列表；若 LAN 服务仍在启动中会等待其就绪。 */
  async readyLanAddresses(): Promise<string[]> {
    const server = this.lanServer ?? (await this.startLan())
    return server?.addresses() ?? []
  }

  private async startLan(): Promise<LanServer | undefined> {
    if (this.disposed || this.suspended || this.lanPort === null) return undefined
    if (this.lanServer) return this.lanServer
    if (this.lanStarting) return this.lanStarting
    const lanGen = ++this.lanGeneration
    const port = this.lanPort
    this.lanStarting = this.computerIdentity()
      .then((identity) =>
        openLanServer(
          {
            onConnection: (conn) => this.acceptLanConnection(identity, lanGen, conn),
          },
          { port },
        ),
      )
      .then((server) => {
        if (this.disposed || this.suspended || lanGen !== this.lanGeneration) {
          server.close()
          return undefined
        }
        this.lanServer = server
        return server
      })
      .catch(() => undefined)
      .finally(() => {
        if (lanGen === this.lanGeneration) this.lanStarting = undefined
      })
    return this.lanStarting
  }

  private stopLan(): void {
    ++this.lanGeneration
    this.lanStarting = undefined
    const server = this.lanServer
    this.lanServer = undefined
    server?.close()
  }

  private acceptLanConnection(identity: NoiseKeyPair, lanGen: number, conn: LanConnection) {
    if (this.disposed || this.suspended || lanGen !== this.lanGeneration) {
      conn.close()
      return { onMessage: () => {}, onClose: () => {} }
    }
    const session = -(++this.nextLanSession)
    const peer: Peer = {
      phase: "handshake",
      transport: {
        channel: "lan",
        send: (payload) => conn.send(payload),
        close: () => conn.close(),
      },
    }
    this.peers.set(session, peer)
    this.armPeer(session, peer)
    return {
      onMessage: (ciphertext: Buffer) => {
        if (!this.disposed && !this.suspended && lanGen === this.lanGeneration) {
          this.receive(identity, session, ciphertext)
        }
      },
      onClose: () => {
        this.dropPeer(session, false)
      },
    }
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
    this.identity ??= loadComputerIdentity(this.ctx.settings, this.cipher, this.devices.size > 0)
      .catch((error: unknown) => {
        this.identity = undefined
        throw error
      })
    return this.identity
  }

  private ensureRelay(
    identity: NoiseKeyPair,
    config: { address: string; token: string },
  ): Promise<RelayHost> {
    if (this.disposed || this.suspended) return Promise.reject(new Error("Host unavailable"))
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
          const peer: Peer = {
            phase: "handshake",
            transport: {
              channel: "relay",
              send: (payload) => this.connection?.send(session, payload),
              close: () => this.connection?.closeSession(session),
            },
          }
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
        push: this.push.proveIdentity(identity, current),
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

  private disconnect(includeLan = false): void {
    ++this.generation
    this.registration?.abort()
    this.registration = undefined
    this.opening = undefined
    const connection = this.connection
    this.connection = undefined
    connection?.close()
    clearTimeout(this.retry)
    this.retry = undefined
    for (const [session, peer] of [...this.peers]) {
      if (includeLan || peer.transport.channel === "relay") {
        this.dropPeer(session, peer.transport.channel === "lan")
      }
    }
  }

  private scheduleReconnect(delay = 2500): void {
    if (this.disposed || this.suspended || this.retry || this.devices.size === 0) return
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
    if (close) peer.transport.close()
  }

  private peerHost(): PeerHostContext {
    return {
      ctx: this.ctx,
      feed: this.feed,
      devices: this.devices,
      relay: this.relay,
      push: this.push,
      computerName: this.computerName,
      now: this.now,
      currentAttempt: () => this.attempt,
      lanAddresses: () => this.lanServer?.addresses() ?? [],
      armPeer: (session, peer) => this.armPeer(session, peer),
      dropPeer: (session, close) => this.dropPeer(session, close),
      onVerifyStatus: () => {
        this.status = "verify"
      },
    }
  }

  private send(_session: number, peer: Peer, message: unknown): void {
    sendPeerMessage(peer, message)
  }

  private receive(identity: NoiseKeyPair, session: number, ciphertext: Buffer): void {
    this.expire()
    const peer = this.peers.get(session)
    if (!peer) return
    try {
      if (peer.phase === "handshake") {
        authenticatePeer(this.peerHost(), identity, session, peer, ciphertext)
        return
      }
      if (!peer.noise) throw new Error("missing Noise session")
      const message: unknown = JSON.parse(peer.noise.decrypt(ciphertext).toString("utf8"))
      switch (peer.phase) {
        case "proof":
          requestPeerApproval(this.peerHost(), session, peer, message)
          break
        case "approval":
          this.dropPeer(session, true)
          break
        case "hello":
          negotiatePeer(this.peerHost(), identity, session, peer, message)
          break
        case "ready":
          peer.rpc?.receive(message)
          break
      }
    } catch {
      this.dropPeer(session, true)
    }
  }
}
