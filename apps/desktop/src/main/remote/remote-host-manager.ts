/**
 * Electron Main 多主机连接管理器：
 * 管理所有已保存远程主机的出站 Noise 会话、断线指数退避重连、配对状态机，
 * 并通过独立的 `MessagePort` 将远程 `RpcServer` 通道透明交付给 Renderer。
 */
import { hostname } from "node:os"
import {
  HOST_LOCAL_ID,
  parseDesktopPairingInput,
  type DesktopPlatform,
  type HostBadgeColor,
  type HostChannel,
  type HostConnectionStatus,
  type HostDefaults,
  type HostOutboundPairingStatus,
  type HostSummary,
} from "@pigcode/contracts"
import type { RelayCredentialCipher } from "@pigcode/host/services/relay-settings"
import { RemoteHostStore, type StoredRemoteHost } from "./remote-host-store"
import {
  connectSavedRemoteHost,
  pairWithRemoteHost,
  RemoteConnectError,
  type RemoteNoiseSession,
} from "./remote-noise-client"
import {
  bindRemoteSessionPort,
  detectDesktopPlatform,
  type ChannelPair,
  type PortLike,
} from "./remote-port-bridge"

export type { ChannelPair, PortLike }

export interface RemoteHostManagerDeps {
  profileDir: string
  cipher?: RelayCredentialCipher | undefined
  localName?: string | undefined
  localPlatform?: DesktopPlatform | undefined
  createChannel: () => ChannelPair
  onHostsChanged?: ((hosts: HostSummary[], defaults: HostDefaults) => void) | undefined
  onPairingChanged?: ((state: HostOutboundPairingStatus) => void) | undefined
  onPortReady?: ((hostId: string, port: PortLike) => void) | undefined
}

interface LiveHostEntry {
  status: HostConnectionStatus
  channel: Exclude<HostChannel, "local"> | "relay"
  latencyMs: number | null
  lastError: string | null
  session: RemoteNoiseSession | undefined
  portBinding: PortLike | undefined
  retryTimer: ReturnType<typeof setTimeout> | undefined
  retries: number
  connectingController: AbortController | undefined
}

const BACKOFF_MS = [2_000, 5_000, 15_000, 30_000]

export class RemoteHostManager {
  private readonly store: RemoteHostStore
  private readonly localName: string
  private readonly localPlatform: DesktopPlatform
  private readonly live = new Map<string, LiveHostEntry>()
  private localHostKey: string | null = null
  private pairingController: AbortController | undefined
  private pairingState: HostOutboundPairingStatus = {
    state: "idle",
    hostName: null,
    hostKey: null,
    verificationCode: null,
    hostId: null,
    errorCode: null,
  }
  private disposed = false

  constructor(private readonly deps: RemoteHostManagerDeps) {
    this.store = new RemoteHostStore(deps.profileDir, { cipher: deps.cipher })
    this.localName = deps.localName ?? (hostname().split(".")[0]?.slice(0, 80) || "Pigcode Desktop")
    this.localPlatform = deps.localPlatform ?? detectDesktopPlatform()
    for (const saved of this.store.listHosts()) {
      this.ensureEntry(saved)
    }
  }

  /** 启动后异步触发已保存远程主机的自动重连。 */
  startAutoConnect(): void {
    if (this.disposed) return
    for (const host of this.store.listHosts()) {
      void this.connectHost(host.id)
    }
  }

  setLocalHostKey(hostKey: string | null): void {
    this.localHostKey = hostKey
  }

  getDefaults(): HostDefaults {
    return { defaultTargetHostId: this.store.getDefaultTargetHostId() }
  }

  setDefaultTargetHostId(hostId: string): HostDefaults {
    const saved = this.store.setDefaultTargetHostId(hostId)
    const defaults = { defaultTargetHostId: saved }
    this.emitHostsChanged()
    return defaults
  }

  getPairingState(): HostOutboundPairingStatus {
    return this.pairingState
  }

  listSummaries(): HostSummary[] {
    return this.store.listHosts().map((saved) => {
      const state = this.live.get(saved.id)
      return {
        id: saved.id,
        name: saved.name,
        hostKey: saved.hostKey,
        kind: saved.kind,
        badgeColor: saved.badgeColor,
        status: state?.status ?? "offline",
        channel:
          state?.channel ??
          (saved.lanAddresses.length > 0 && !saved.relayAddress ? "lan" : "relay"),
        latencyMs: state?.latencyMs ?? null,
        lanAddresses: [...saved.lanAddresses],
        relayAddress: saved.relayAddress,
        lastConnectedAt: saved.lastConnectedAt,
        lastError: state?.lastError ?? null,
      }
    })
  }

  /** 窗口（重新）加载完成时，为全部当前在线的远程主机重新下发独立 MessagePort。 */
  attachWindowPorts(): void {
    if (this.disposed) return
    for (const [hostId, entry] of this.live) {
      if (entry.status === "connected" && entry.session) {
        this.attachEntryPort(hostId, entry)
      }
    }
  }

  async startPairing(input: {
    link: string
    customName?: string | undefined
    badgeColor?: HostBadgeColor | undefined
  }): Promise<HostOutboundPairingStatus> {
    this.cancelPairing(false)

    const parsed = parseDesktopPairingInput(input.link)
    if (!parsed.ok) {
      return this.setPairingState({
        state: "failed",
        hostName: null,
        hostKey: null,
        verificationCode: null,
        hostId: null,
        errorCode: parsed.code,
      })
    }
    const { payload } = parsed
    if (Date.now() > payload.expiresAt) {
      return this.setPairingState({
        state: "failed",
        hostName: payload.hostName,
        hostKey: payload.hostKey,
        verificationCode: null,
        hostId: null,
        errorCode: "expired",
      })
    }
    if (this.localHostKey && payload.hostKey === this.localHostKey) {
      return this.setPairingState({
        state: "failed",
        hostName: payload.hostName,
        hostKey: payload.hostKey,
        verificationCode: null,
        hostId: null,
        errorCode: "self-pairing",
      })
    }

    const controller = new AbortController()
    this.pairingController = controller
    this.setPairingState({
      state: "connecting",
      hostName: input.customName?.trim() || payload.hostName,
      hostKey: payload.hostKey,
      verificationCode: null,
      hostId: null,
      errorCode: null,
    })

    try {
      const clientIdentity = await this.store.getOrCreateClientIdentity()
      if (controller.signal.aborted) return this.pairingState

      const session = await pairWithRemoteHost({
        payload,
        clientIdentity,
        localName: this.localName,
        localPlatform: this.localPlatform,
        signal: controller.signal,
        onVerify: (code) => {
          if (this.pairingController !== controller || controller.signal.aborted) return
          this.setPairingState({
            state: "verify",
            hostName: input.customName?.trim() || payload.hostName,
            hostKey: payload.hostKey,
            verificationCode: code,
            hostId: null,
            errorCode: null,
          })
        },
      })

      if (controller.signal.aborted || this.disposed) {
        session.close()
        return this.pairingState
      }

      const kind = RemoteHostStore.normalizeKind(session.runtime)
      const stored = await this.store.upsertHost({
        name: input.customName?.trim() || session.hostName || payload.hostName,
        hostKey: payload.hostKey,
        kind,
        badgeColor: input.badgeColor,
        relayAddress: payload.address,
        relayToken: payload.token,
        lanAddresses:
          session.lanAddresses.length > 0 ? session.lanAddresses : (payload.lanAddresses ?? []),
        lastConnectedAt: Date.now(),
      })

      this.pairingController = undefined
      this.installLiveSession(stored, session)
      return this.setPairingState({
        state: "paired",
        hostName: stored.name,
        hostKey: stored.hostKey,
        verificationCode: null,
        hostId: stored.id,
        errorCode: null,
      })
    } catch (error) {
      if (this.pairingController === controller) this.pairingController = undefined
      if (controller.signal.aborted) return this.pairingState
      const errorCode = error instanceof RemoteConnectError ? error.code : "unreachable"
      return this.setPairingState({
        state: "failed",
        hostName: input.customName?.trim() || payload.hostName,
        hostKey: payload.hostKey,
        verificationCode: null,
        hostId: null,
        errorCode,
      })
    }
  }

  cancelPairing(resetToIdle = true): HostOutboundPairingStatus {
    this.pairingController?.abort()
    this.pairingController = undefined
    if (resetToIdle) {
      return this.setPairingState({
        state: "idle",
        hostName: null,
        hostKey: null,
        verificationCode: null,
        hostId: null,
        errorCode: null,
      })
    }
    return this.pairingState
  }

  async reconnectHost(id: string): Promise<HostSummary | null> {
    if (id === HOST_LOCAL_ID) return null
    const saved = this.store.findHost(id)
    if (!saved) return null
    const entry = this.ensureEntry(saved)
    clearTimeout(entry.retryTimer)
    entry.retryTimer = undefined
    entry.retries = 0
    await this.connectHost(id)
    return this.listSummaries().find((item) => item.id === id) ?? null
  }

  renameHost(id: string, name: string): HostSummary | null {
    const updated = this.store.renameHost(id, name)
    if (!updated) return null
    this.emitHostsChanged()
    return this.listSummaries().find((item) => item.id === id) ?? null
  }

  setBadgeColor(id: string, color: HostBadgeColor): HostSummary | null {
    const updated = this.store.setBadgeColor(id, color)
    if (!updated) return null
    this.emitHostsChanged()
    return this.listSummaries().find((item) => item.id === id) ?? null
  }

  removeHost(id: string): boolean {
    const entry = this.live.get(id)
    if (entry) {
      clearTimeout(entry.retryTimer)
      entry.connectingController?.abort()
      entry.portBinding?.close()
      entry.session?.close()
      this.live.delete(id)
    }
    const removed = this.store.removeHost(id)
    if (removed) this.emitHostsChanged()
    return removed
  }

  dispose(): void {
    this.disposed = true
    this.pairingController?.abort()
    this.pairingController = undefined
    for (const entry of this.live.values()) {
      clearTimeout(entry.retryTimer)
      entry.connectingController?.abort()
      entry.portBinding?.close()
      entry.session?.close()
    }
    this.live.clear()
  }

  private async connectHost(id: string): Promise<void> {
    if (this.disposed) return
    const saved = this.store.findHost(id)
    if (!saved) return
    const entry = this.ensureEntry(saved)
    if (entry.connectingController || entry.status === "connected") return

    const controller = new AbortController()
    entry.connectingController = controller
    entry.status = "connecting"
    entry.lastError = null
    this.emitHostsChanged()

    try {
      const [identity, relayToken] = await Promise.all([
        this.store.getOrCreateClientIdentity(),
        this.store.unsealRelayToken(saved),
      ])
      if (controller.signal.aborted || this.disposed) return
      const session = await connectSavedRemoteHost({
        hostKey: saved.hostKey,
        lanAddresses: saved.lanAddresses,
        relayAddress: saved.relayAddress,
        relayToken,
        clientIdentity: identity,
        signal: controller.signal,
      })
      if (controller.signal.aborted || this.disposed) {
        session.close()
        return
      }
      entry.connectingController = undefined
      entry.retries = 0
      const latest =
        this.store.updateConnectionMeta(saved.id, {
          lastConnectedAt: Date.now(),
          kind: RemoteHostStore.normalizeKind(session.runtime),
          ...(session.lanAddresses.length > 0 ? { lanAddresses: session.lanAddresses } : {}),
        }) ?? saved
      this.installLiveSession(latest, session)
    } catch (error) {
      if (entry.connectingController === controller) entry.connectingController = undefined
      if (controller.signal.aborted || this.disposed) return
      const code = error instanceof RemoteConnectError ? error.code : "unreachable"
      entry.status =
        code === "revoked"
          ? "revoked"
          : code === "token-rejected"
            ? "auth-failed"
            : code === "incompatible"
              ? "incompatible"
              : "offline"
      entry.lastError = error instanceof Error ? error.message : String(error)
      entry.latencyMs = null
      this.emitHostsChanged()
      if (entry.status === "offline") {
        this.scheduleReconnect(saved.id, entry)
      }
    }
  }

  private ensureEntry(saved: StoredRemoteHost): LiveHostEntry {
    let entry = this.live.get(saved.id)
    if (!entry) {
      entry = {
        status: "offline",
        channel: saved.lanAddresses.length > 0 && !saved.relayAddress ? "lan" : "relay",
        latencyMs: null,
        lastError: null,
        session: undefined,
        portBinding: undefined,
        retryTimer: undefined,
        retries: 0,
        connectingController: undefined,
      }
      this.live.set(saved.id, entry)
    }
    return entry
  }

  private installLiveSession(saved: StoredRemoteHost, session: RemoteNoiseSession): void {
    const entry = this.ensureEntry(saved)
    clearTimeout(entry.retryTimer)
    entry.retryTimer = undefined
    entry.connectingController?.abort()
    entry.connectingController = undefined
    entry.portBinding?.close()
    entry.portBinding = undefined
    entry.session?.close()

    entry.session = session
    entry.status = "connected"
    entry.channel = session.channel
    entry.latencyMs = session.latencyMs
    entry.lastError = null
    entry.retries = 0

    session.onClose((reason) => {
      if (entry.session !== session || this.disposed) return
      entry.session = undefined
      entry.portBinding?.close()
      entry.portBinding = undefined
      entry.latencyMs = null
      entry.status = reason === "revoked" ? "revoked" : "offline"
      entry.lastError = reason === "revoked" ? "revoked by remote host" : null
      this.emitHostsChanged()
      if (reason !== "revoked") this.scheduleReconnect(saved.id, entry)
    })

    this.attachEntryPort(saved.id, entry)
    this.emitHostsChanged()
  }

  private attachEntryPort(hostId: string, entry: LiveHostEntry): void {
    if (!entry.session) return
    entry.portBinding?.close()
    entry.portBinding = bindRemoteSessionPort(this.deps.createChannel, entry.session, (port) => {
      this.deps.onPortReady?.(hostId, port)
    })
  }

  private scheduleReconnect(id: string, entry: LiveHostEntry): void {
    if (this.disposed || entry.retryTimer) return
    const delay = BACKOFF_MS[Math.min(entry.retries, BACKOFF_MS.length - 1)]!
    entry.retries += 1
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined
      void this.connectHost(id)
    }, delay).unref()
  }

  private setPairingState(next: HostOutboundPairingStatus): HostOutboundPairingStatus {
    this.pairingState = next
    this.deps.onPairingChanged?.(next)
    return next
  }

  private emitHostsChanged(): void {
    this.deps.onHostsChanged?.(this.listSummaries(), this.getDefaults())
  }
}
