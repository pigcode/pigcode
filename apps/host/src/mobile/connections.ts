import { randomBytes, randomUUID } from "node:crypto"
import { hostname } from "node:os"
import type {
  DesktopPairingView,
  DesktopRevokeResult,
  MobilePairingView,
  MobileRevokeResult,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import type { ThreadFeed } from "../rpc/thread-feed"
import type { RelayCredentialCipher, RelaySettings } from "../services/relay-settings"
import { loadComputerIdentity } from "./computer-identity"
import {
  approvePeerCandidate,
  createPeerHostContext,
  disconnectRevokedPeers,
  dispatchPeerCiphertext,
  releaseAttemptPeers,
} from "./connections-dispatch"
import { type Peer } from "./connections-peer"
import { HostTransportController } from "./connections-transport"
import type { LanServer } from "./lan-server"
import type { NoiseKeyPair } from "./noise"
import { PairedDevices } from "./paired-devices"
import {
  desktopPairingAttemptView,
  desktopPairingLink,
  pairingAttemptView,
  pairingQRCode,
  pairingValidityMs,
  type DesktopAttempt,
  type MobileAttempt,
} from "./pairing-attempt"
import { MobilePushReminders } from "./push-reminders"
import { revokeDeviceWork } from "./revocation"

type MobileStatus = MobilePairingView["status"]
type DesktopStatus = DesktopPairingView["status"]

const HOST_NAME_KEY = "host.name"

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
  private readonly fallbackComputerName = hostname().split(".")[0]?.slice(0, 80) || "Pigcode"
  private peers = new Map<number, Peer>()
  readonly devices: PairedDevices
  private readonly push: MobilePushReminders
  private readonly transports: HostTransportController
  private readonly now: () => number
  private status: MobileStatus = "idle"
  private desktopStatus: DesktopStatus = "idle"
  private attempt: MobileAttempt | undefined
  private desktopAttempt: DesktopAttempt | undefined
  private identity: Promise<NoiseKeyPair> | undefined
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
    const lanPort = options.lanPort === false ? null : (options.lanPort ?? 0)
    this.devices = new PairedDevices(ctx.settings)
    this.push = new MobilePushReminders(
      ctx,
      this.devices,
      cipher,
      () => this.transports.relayConnection,
    )
    this.transports = new HostTransportController({
      relay,
      push: this.push,
      lanPort,
      getIdentity: () => this.computerIdentity(),
      isActive: () => !this.disposed && !this.suspended,
      canAutoReconnect: () => !this.disposed && !this.suspended && this.devices.size > 0,
      onPeerOpened: (session, peer) => {
        this.peers.set(session, peer)
        this.armPeer(session, peer)
      },
      onPeerClosed: (session, close) => this.dropPeer(session, close),
      onPeerCiphertext: (identity, session, ciphertext) =>
        this.receive(identity, session, ciphertext),
      onDropTransports: (includeLan) => {
        for (const [session, peer] of [...this.peers]) {
          if (includeLan || peer.transport.channel === "relay") {
            this.dropPeer(session, peer.transport.channel === "lan")
          }
        }
      },
      onRelayDisconnected: () => {
        if (this.attempt) this.finishMobile("relay-unavailable", false)
        if (this.desktopAttempt) this.finishDesktop("relay-unavailable", false)
      },
    })
    this.unsubscribe = relay.onConnectionChange(() => {
      this.finishMobile(this.attempt ? "cancelled" : "idle", false)
      this.finishDesktop(this.desktopAttempt ? "cancelled" : "idle", false)
      this.transports.disconnect()
      this.transports.scheduleReconnect(0)
    })
    this.transports.scheduleReconnect(0)
    void this.transports.startLan()
  }

  /** 读取当前主机展示名（优先用户设置的 `host.name`，缺省用本机主机名）。 */
  hostName(): string {
    const raw = this.ctx.settings.get(HOST_NAME_KEY)
    if (typeof raw === "string") {
      const trimmed = raw.trim().slice(0, 80)
      if (trimmed.length > 0) return trimmed
    }
    return this.fallbackComputerName
  }

  /** 设置并持久化当前主机展示名。 */
  setHostName(name: string): string {
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed) throw new Error("host name cannot be empty")
    this.ctx.settings.set(HOST_NAME_KEY, trimmed)
    return trimmed
  }

  /** 返回本机 Noise 公钥（base64url）与主机名。 */
  async hostIdentity(): Promise<{ hostKey: string; hostName: string }> {
    const identity = await this.computerIdentity()
    return {
      hostKey: identity.publicKey.toString("base64url"),
      hostName: this.hostName(),
    }
  }

  view(): MobilePairingView {
    this.expire()
    const connected = this.connectedKeysFor("mobile")
    return {
      status: this.status,
      attempt: pairingAttemptView(this.attempt),
      devices: this.devices.view(this.relay.revision, connected),
    }
  }

  desktopView(): DesktopPairingView {
    this.expire()
    const connected = this.connectedKeysFor("desktop")
    return {
      status: this.desktopStatus,
      attempt: desktopPairingAttemptView(this.desktopAttempt),
      clients: this.devices.desktopView(connected),
    }
  }

  async start(): Promise<MobilePairingView> {
    this.finishMobile("cancelled", false)
    if (!this.relay.view().tokenConfigured) {
      this.finishMobile("needs-relay")
      return this.view()
    }
    const attempt: MobileAttempt = {
      role: "mobile",
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
        this.finishMobile("needs-relay")
        return this.view()
      }
      const qr = pairingQRCode(attempt, config, identity.publicKey, this.hostName())
      if (Buffer.byteLength(qr) > 2953) {
        this.finishMobile("qr-unavailable")
        return this.view()
      }
      try {
        await this.transports.ensureRelay(identity, config)
      } catch {
        if (this.attempt === attempt) this.finishMobile("relay-unavailable")
        return this.view()
      }
      if (this.attempt === attempt) {
        attempt.qr = qr
        this.status = "waiting"
      }
    } catch {
      if (this.attempt === attempt) this.finishMobile("storage-unavailable")
    }
    return this.view()
  }

  async startDesktopPairing(): Promise<DesktopPairingView> {
    this.finishDesktop("cancelled", false)
    const attempt: DesktopAttempt = {
      role: "desktop",
      id: randomUUID(),
      expiresAt: this.now() + pairingValidityMs,
      secret: randomBytes(32),
      timer: setTimeout(() => this.expire(), pairingValidityMs).unref(),
      link: null,
      lanAddresses: [],
      candidate: null,
    }
    this.desktopAttempt = attempt
    this.desktopStatus = "connecting"
    try {
      const [identity, config, lanAddresses] = await Promise.all([
        this.computerIdentity(),
        this.relay.connectionConfig(),
        this.readyLanAddresses(),
      ])
      if (this.desktopAttempt !== attempt) return this.desktopView()
      if (!config && lanAddresses.length === 0) {
        this.finishDesktop("needs-relay")
        return this.desktopView()
      }
      if (config) {
        try {
          await this.transports.ensureRelay(identity, config)
        } catch {
          if (this.desktopAttempt === attempt) this.finishDesktop("relay-unavailable")
          return this.desktopView()
        }
      }
      if (this.desktopAttempt === attempt) {
        attempt.lanAddresses = lanAddresses
        attempt.link = desktopPairingLink(
          attempt,
          config ?? null,
          identity.publicKey,
          this.hostName(),
          lanAddresses,
        )
        this.desktopStatus = "waiting"
      }
    } catch {
      if (this.desktopAttempt === attempt) this.finishDesktop("storage-unavailable")
    }
    return this.desktopView()
  }

  cancel(id: string): MobilePairingView {
    if (this.attempt?.id === id) this.finishMobile("cancelled")
    return this.view()
  }

  cancelDesktopPairing(id: string): DesktopPairingView {
    if (this.desktopAttempt?.id === id) this.finishDesktop("cancelled")
    return this.desktopView()
  }

  confirm(id: string, confirmation: string): MobilePairingView {
    this.expire()
    const revision = this.relay.revision
    return approvePeerCandidate({
      id,
      confirmation,
      attempt: this.attempt,
      peers: this.peers,
      devices: this.devices,
      armPeer: (s, p) => this.armPeer(s, p),
      dropPeer: (s, c) => this.dropPeer(s, c),
      viewFor: () => this.view(),
      onStorageError: () => this.finishMobile("storage-unavailable"),
      prepareDevice: (d) => ({ ...d, confirmedRelayRevision: revision }),
      approvedPayload: () => ({ type: "device.approved", relayRevision: revision }),
      onApproved: (c) => this.finishMobile(c.mode === "update" ? "update-approved" : "paired"),
    })
  }

  confirmDesktopPairing(id: string, confirmation: string): DesktopPairingView {
    this.expire()
    return approvePeerCandidate({
      id,
      confirmation,
      attempt: this.desktopAttempt,
      peers: this.peers,
      devices: this.devices,
      armPeer: (s, p) => this.armPeer(s, p),
      dropPeer: (s, c) => this.dropPeer(s, c),
      viewFor: () => this.desktopView(),
      onStorageError: () => this.finishDesktop("storage-unavailable"),
      prepareDevice: (d) => d,
      approvedPayload: () => ({ type: "device.approved", hostName: this.hostName() }),
      onApproved: () => this.finishDesktop("paired"),
    })
  }

  revoke(deviceId: string): MobileRevokeResult {
    return this.revokeByRole("mobile", deviceId, () => this.view())
  }

  revokeDesktop(deviceId: string): DesktopRevokeResult {
    return this.revokeByRole("desktop", deviceId, () => this.desktopView())
  }

  private revokeByRole<TView>(
    role: "mobile" | "desktop",
    deviceId: string,
    viewFor: () => TView,
  ): { status: "missing-device" | "storage-unavailable" | "revoked"; pairing: TView } {
    const device = this.devices.findById(deviceId, role)
    if (!device) return { status: "missing-device", pairing: viewFor() }
    try {
      this.devices.remove(device)
    } catch {
      return { status: "storage-unavailable", pairing: viewFor() }
    }
    const cancelAttempt = disconnectRevokedPeers({
      peers: this.peers,
      publicKey: device.publicKey,
      mobileAttempt: this.attempt,
      desktopAttempt: this.desktopAttempt,
      forceNotice: role === "desktop",
      dropPeer: (session, close) => this.dropPeer(session, close),
    })
    if (this.hasNoActiveGrantOrAttempt() || cancelAttempt) {
      if (role === "mobile") this.finishMobile(this.attempt ? "cancelled" : "idle")
      else this.finishDesktop(this.desktopAttempt ? "cancelled" : "idle")
    }
    revokeDeviceWork(this.ctx, device.publicKey)
    return { status: "revoked", pairing: viewFor() }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe()
    this.finishMobile("cancelled", false)
    this.finishDesktop("cancelled", false)
    this.transports.disconnect(true)
    this.transports.stopLan()
  }

  announceExit(state: "exited" | "restarting"): void {
    this.transports.announce(state)
  }

  setSuspended(suspended: boolean): void {
    if (this.disposed || this.suspended === suspended) return
    this.suspended = suspended
    if (suspended) {
      this.transports.announce("sleeping")
      if (this.attempt) this.finishMobile("cancelled", false)
      if (this.desktopAttempt) this.finishDesktop("cancelled", false)
      this.transports.disconnect(true)
      this.transports.stopLan()
    } else {
      this.transports.disconnect(false)
      this.transports.scheduleReconnect(0)
      void this.transports.startLan()
    }
  }

  /** 返回当前可用的局域网直连地址列表；若 LAN 服务仍在启动中会等待其就绪。 */
  readyLanAddresses(): Promise<string[]> {
    return this.transports.readyLanAddresses()
  }

  /** 返回当前已启动的 LAN 服务实例。 */
  get lanServer(): LanServer | undefined {
    return this.transports.currentLanServer
  }

  private connectedKeysFor(role: "mobile" | "desktop"): Set<string> {
    const connected = new Set<string>()
    for (const peer of this.peers.values()) {
      if (peer.phase === "ready" && peer.role === role && peer.device) {
        connected.add(peer.device.publicKey)
      }
    }
    return connected
  }

  private hasNoActiveGrantOrAttempt(): boolean {
    return this.devices.size === 0 && !this.attempt && !this.desktopAttempt
  }

  private expire(): void {
    const now = this.now()
    if (this.attempt && now >= this.attempt.expiresAt) this.finishMobile("expired")
    if (this.desktopAttempt && now >= this.desktopAttempt.expiresAt) {
      this.finishDesktop("expired")
    }
  }

  private finishMobile(status: MobileStatus, closeIdle = true): void {
    const attempt = this.attempt
    this.attempt = undefined
    this.status = status
    releaseAttemptPeers(attempt, this.peers, (s, c) => this.dropPeer(s, c))
    if (closeIdle && this.hasNoActiveGrantOrAttempt()) this.transports.disconnect()
  }

  private finishDesktop(status: DesktopStatus, closeIdle = true): void {
    const attempt = this.desktopAttempt
    this.desktopAttempt = undefined
    this.desktopStatus = status
    releaseAttemptPeers(attempt, this.peers, (s, c) => this.dropPeer(s, c))
    if (closeIdle && this.hasNoActiveGrantOrAttempt()) this.transports.disconnect()
  }

  private computerIdentity(): Promise<NoiseKeyPair> {
    this.identity ??= loadComputerIdentity(
      this.ctx.settings,
      this.cipher,
      this.devices.size > 0,
    ).catch((error: unknown) => {
      this.identity = undefined
      throw error
    })
    return this.identity
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
    if (this.desktopAttempt?.candidate?.session === session) {
      this.desktopAttempt.candidate = null
      this.desktopStatus = "waiting"
    }
    if (close) peer.transport.close()
  }

  private receive(identity: NoiseKeyPair, session: number, ciphertext: Buffer): void {
    this.expire()
    const peer = this.peers.get(session)
    if (!peer) return
    dispatchPeerCiphertext({
      identity,
      session,
      peer,
      ciphertext,
      host: createPeerHostContext({
        ctx: this.ctx,
        feed: this.feed,
        devices: this.devices,
        relay: this.relay,
        push: this.push,
        hostName: () => this.hostName(),
        now: this.now,
        currentMobileAttempt: () => this.attempt,
        currentDesktopAttempt: () => this.desktopAttempt,
        lanAddresses: () => this.transports.lanAddresses(),
        armPeer: (s, p) => this.armPeer(s, p),
        dropPeer: (s, c) => this.dropPeer(s, c),
        onMobileVerifyStatus: () => {
          this.status = "verify"
        },
        onDesktopVerifyStatus: () => {
          this.desktopStatus = "verify"
        },
      }),
      dropPeer: (sid, close) => this.dropPeer(sid, close),
    })
  }
}
