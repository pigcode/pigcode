/**
 * Electron Main 远程主机持久化存储（`<profileDir>/remote-hosts.json`）：
 * 与 Host 私有的 `settings.json` 物理隔离，使用同一套 `credential.key` AES-256-GCM 主密钥
 * 密封保存客户端 Noise 私钥种子与各远程主机的中继令牌。
 */
import { createHash } from "node:crypto"
import { chmodSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  hostBadgeColorSchema,
  HOST_LOCAL_ID,
  publicKeySchema,
  remoteHostsFileSchema,
  type HostBadgeColor,
  type HostKind,
  type RemoteHostsFile,
  type StoredRemoteHost,
} from "@pigcode/contracts"
import { noiseKeyPair, type NoiseKeyPair } from "@pigcode/host/mobile/noise"
import { writeFileAtomicSync } from "@pigcode/host/services/atomic-write"
import { createLocalCredentialCipher } from "@pigcode/host/services/local-credential"
import type { RelayCredentialCipher } from "@pigcode/host/services/relay-settings"

export type { StoredRemoteHost }

const REMOTE_HOSTS_FILE = "remote-hosts.json"
const REMOTE_COLORS: readonly HostBadgeColor[] = ["green", "amber", "violet", "rose", "slate"]

function hostIdFromKey(hostKey: string): string {
  return createHash("sha256").update(Buffer.from(hostKey, "base64url")).digest("hex").slice(0, 16)
}

function emptyFile(): RemoteHostsFile {
  return {
    version: 1,
    defaultTargetHostId: HOST_LOCAL_ID,
    hosts: [],
  }
}

function readHostsFile(filePath: string): RemoteHostsFile {
  if (!existsSync(filePath)) return emptyFile()
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown
    const parsed = remoteHostsFileSchema.safeParse(raw)
    return parsed.success ? parsed.data : emptyFile()
  } catch {
    return emptyFile()
  }
}

export class RemoteHostStore {
  private readonly filePath: string
  private readonly cipher: RelayCredentialCipher
  private data: RemoteHostsFile

  constructor(
    profileDir: string,
    options: {
      cipher?: RelayCredentialCipher | undefined
      env?: NodeJS.ProcessEnv | undefined
    } = {},
  ) {
    this.filePath = join(profileDir, REMOTE_HOSTS_FILE)
    this.cipher = options.cipher ?? createLocalCredentialCipher(profileDir, options.env)
    this.data = readHostsFile(this.filePath)
  }

  private persist(): void {
    writeFileAtomicSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`)
    try {
      chmodSync(this.filePath, 0o600)
    } catch {
      // Windows does not support POSIX mode bits in chmodSync
    }
  }

  async getOrCreateClientIdentity(): Promise<NoiseKeyPair> {
    if (this.data.clientKeySealed) {
      const seed = publicKeySchema.parse(await this.cipher.open(this.data.clientKeySealed))
      return noiseKeyPair(Buffer.from(seed, "base64url"))
    }
    const pair = noiseKeyPair()
    const sealed = await this.cipher.seal(pair.seed.toString("base64url"))
    this.data = { ...this.data, clientKeySealed: sealed }
    this.persist()
    return pair
  }

  listHosts(): readonly StoredRemoteHost[] {
    return this.data.hosts
  }

  findHost(id: string): StoredRemoteHost | undefined {
    return this.data.hosts.find((item) => item.id === id)
  }

  findHostByKey(hostKey: string): StoredRemoteHost | undefined {
    return this.data.hosts.find((item) => item.hostKey === hostKey)
  }

  nextBadgeColor(): HostBadgeColor {
    const used = new Set(this.data.hosts.map((host) => host.badgeColor))
    return (
      REMOTE_COLORS.find((color) => !used.has(color)) ??
      REMOTE_COLORS[this.data.hosts.length % REMOTE_COLORS.length]!
    )
  }

  async upsertHost(input: {
    name: string
    hostKey: string
    kind: Extract<HostKind, "desktop" | "headless">
    badgeColor?: HostBadgeColor | undefined
    relayAddress: string | null
    relayToken: string | null
    lanAddresses: string[]
    lastConnectedAt: number | null
  }): Promise<StoredRemoteHost> {
    const existing = this.findHostByKey(input.hostKey)
    const id = existing?.id ?? hostIdFromKey(input.hostKey)
    const relayTokenSealed =
      input.relayToken !== null ? await this.cipher.seal(input.relayToken) : null
    const nextRecord: StoredRemoteHost = {
      id,
      name: input.name.trim().slice(0, 80) || existing?.name || "Remote Host",
      hostKey: input.hostKey,
      kind: input.kind,
      badgeColor: input.badgeColor ?? existing?.badgeColor ?? this.nextBadgeColor(),
      relayAddress: input.relayAddress,
      relayTokenSealed,
      lanAddresses: [...input.lanAddresses],
      lastConnectedAt: input.lastConnectedAt ?? existing?.lastConnectedAt ?? null,
    }
    this.data = {
      ...this.data,
      hosts: [...this.data.hosts.filter((item) => item.id !== id), nextRecord],
    }
    this.persist()
    return nextRecord
  }

  async unsealRelayToken(host: StoredRemoteHost): Promise<string | null> {
    if (!host.relayTokenSealed) return null
    return this.cipher.open(host.relayTokenSealed)
  }

  updateConnectionMeta(
    id: string,
    patch: {
      lanAddresses?: string[] | undefined
      lastConnectedAt?: number | undefined
      kind?: "desktop" | "headless" | undefined
    },
  ): StoredRemoteHost | undefined {
    const current = this.findHost(id)
    if (!current) return undefined
    const next: StoredRemoteHost = {
      ...current,
      ...(patch.lanAddresses !== undefined ? { lanAddresses: [...patch.lanAddresses] } : {}),
      ...(patch.lastConnectedAt !== undefined ? { lastConnectedAt: patch.lastConnectedAt } : {}),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    }
    this.data = {
      ...this.data,
      hosts: this.data.hosts.map((item) => (item.id === id ? next : item)),
    }
    this.persist()
    return next
  }

  renameHost(id: string, name: string): StoredRemoteHost | undefined {
    const trimmed = name.trim().slice(0, 80)
    if (!trimmed) throw new Error("host name cannot be empty")
    const current = this.findHost(id)
    if (!current) return undefined
    const next = { ...current, name: trimmed }
    this.data = {
      ...this.data,
      hosts: this.data.hosts.map((item) => (item.id === id ? next : item)),
    }
    this.persist()
    return next
  }

  setBadgeColor(id: string, badgeColor: HostBadgeColor): StoredRemoteHost | undefined {
    const validated = hostBadgeColorSchema.parse(badgeColor)
    const current = this.findHost(id)
    if (!current) return undefined
    const next = { ...current, badgeColor: validated }
    this.data = {
      ...this.data,
      hosts: this.data.hosts.map((item) => (item.id === id ? next : item)),
    }
    this.persist()
    return next
  }

  removeHost(id: string): boolean {
    const before = this.data.hosts.length
    const hosts = this.data.hosts.filter((item) => item.id !== id)
    if (hosts.length === before) return false
    const defaultTargetHostId =
      this.data.defaultTargetHostId === id ? HOST_LOCAL_ID : this.data.defaultTargetHostId
    this.data = { ...this.data, hosts, defaultTargetHostId }
    this.persist()
    return true
  }

  getDefaultTargetHostId(): string {
    const id = this.data.defaultTargetHostId
    if (id === HOST_LOCAL_ID || this.findHost(id)) return id
    return HOST_LOCAL_ID
  }

  setDefaultTargetHostId(hostId: string): string {
    if (hostId !== HOST_LOCAL_ID && !this.findHost(hostId)) {
      throw new Error(`unknown host id: ${hostId}`)
    }
    this.data = { ...this.data, defaultTargetHostId: hostId }
    this.persist()
    return hostId
  }

  static normalizeKind(raw: unknown): "desktop" | "headless" {
    return raw === "headless" ? "headless" : "desktop"
  }
}
