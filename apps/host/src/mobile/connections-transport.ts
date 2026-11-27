/** 管理 Host 侧 LAN 监听与 Relay 注册重连传输通道。 */
import type { RelaySettings } from "../services/relay-settings"
import type { Peer } from "./connections-peer"
import { openLanServer, type LanConnection, type LanServer } from "./lan-server"
import type { NoiseKeyPair } from "./noise"
import { fingerprint } from "./paired-devices"
import type { MobilePushReminders } from "./push-reminders"
import { openRelayHost, type RelayHost } from "./relay-host"

export interface HostTransportDeps {
  relay: RelaySettings
  push: MobilePushReminders
  lanPort: number | null
  getIdentity: () => Promise<NoiseKeyPair>
  isActive: () => boolean
  canAutoReconnect: () => boolean
  onPeerOpened: (session: number, peer: Peer) => void
  onPeerClosed: (session: number, close?: boolean) => void
  onPeerCiphertext: (identity: NoiseKeyPair, session: number, ciphertext: Buffer) => void
  onDropTransports: (includeLan: boolean) => void
  onRelayDisconnected: () => void
}

export class HostTransportController {
  private connection: RelayHost | undefined
  private opening: Promise<RelayHost> | undefined
  private registration: AbortController | undefined
  private lanServer: LanServer | undefined
  private lanStarting: Promise<LanServer | undefined> | undefined
  private nextLanSession = 0
  private retry: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private lanGeneration = 0

  constructor(private readonly deps: HostTransportDeps) {}

  get relayConnection(): RelayHost | undefined {
    return this.connection
  }

  get currentLanServer(): LanServer | undefined {
    return this.lanServer
  }

  lanAddresses(): string[] {
    return this.lanServer?.addresses() ?? []
  }

  announce(state: "exited" | "restarting" | "sleeping"): void {
    this.connection?.announce(state)
  }

  async readyLanAddresses(): Promise<string[]> {
    const server = this.lanServer ?? (await this.startLan())
    return server?.addresses() ?? []
  }

  async startLan(): Promise<LanServer | undefined> {
    if (!this.deps.isActive() || this.deps.lanPort === null) return undefined
    if (this.lanServer) return this.lanServer
    if (this.lanStarting) return this.lanStarting
    const lanGen = ++this.lanGeneration
    const port = this.deps.lanPort
    this.lanStarting = this.deps
      .getIdentity()
      .then((identity) =>
        openLanServer(
          {
            onConnection: (conn) => this.acceptLanConnection(identity, lanGen, conn),
          },
          { port },
        ),
      )
      .then((server) => {
        if (!this.deps.isActive() || lanGen !== this.lanGeneration) {
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

  stopLan(): void {
    ++this.lanGeneration
    this.lanStarting = undefined
    const server = this.lanServer
    this.lanServer = undefined
    server?.close()
  }

  ensureRelay(
    identity: NoiseKeyPair,
    config: { address: string; token: string },
  ): Promise<RelayHost> {
    if (!this.deps.isActive()) return Promise.reject(new Error("Host unavailable"))
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
          this.deps.onPeerOpened(session, {
            phase: "handshake",
            transport: {
              channel: "relay",
              send: (payload) => this.connection?.send(session, payload),
              close: () => this.connection?.closeSession(session),
            },
          })
        },
        sessionClosed: (session) => {
          if (current()) this.deps.onPeerClosed(session)
        },
        received: (session, ciphertext) => {
          if (current()) this.deps.onPeerCiphertext(identity, session, ciphertext)
        },
        disconnected: () => {
          if (!current()) return
          this.disconnect()
          this.deps.onRelayDisconnected()
          this.scheduleReconnect()
        },
        push: this.deps.push.proveIdentity(identity, current),
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

  disconnect(includeLan = false): void {
    ++this.generation
    this.registration?.abort()
    this.registration = undefined
    this.opening = undefined
    const connection = this.connection
    this.connection = undefined
    connection?.close()
    clearTimeout(this.retry)
    this.retry = undefined
    this.deps.onDropTransports(includeLan)
  }

  scheduleReconnect(delay = 2500): void {
    if (!this.deps.canAutoReconnect() || this.retry) return
    this.retry = setTimeout(() => {
      this.retry = undefined
      void this.restoreRelay()
    }, delay).unref()
  }

  private acceptLanConnection(identity: NoiseKeyPair, lanGen: number, conn: LanConnection) {
    if (!this.deps.isActive() || lanGen !== this.lanGeneration) {
      conn.close()
      return { onMessage: () => {}, onClose: () => {} }
    }
    const session = -++this.nextLanSession
    this.deps.onPeerOpened(session, {
      phase: "handshake",
      transport: {
        channel: "lan",
        send: (payload) => conn.send(payload),
        close: () => conn.close(),
      },
    })
    return {
      onMessage: (ciphertext: Buffer) => {
        if (this.deps.isActive() && lanGen === this.lanGeneration) {
          this.deps.onPeerCiphertext(identity, session, ciphertext)
        }
      },
      onClose: () => {
        this.deps.onPeerClosed(session, false)
      },
    }
  }

  private async restoreRelay(): Promise<void> {
    const generation = this.generation
    try {
      const config = await this.deps.relay.connectionConfig()
      if (!config) return
      const identity = await this.deps.getIdentity()
      if (generation === this.generation) await this.ensureRelay(identity, config)
    } catch {
      this.scheduleReconnect()
    }
  }
}
