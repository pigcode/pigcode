import { createHash, randomUUID } from "node:crypto"
import {
  desktopPlatformSchema,
  devicePlatformSchema,
  pairedDeviceSchema,
  type ClientRole,
  type DesktopAuthorizedClient,
  type MobilePairingView,
  type MobileReminderSettings,
  type PairedDevice,
} from "@pigcode/contracts"
import type { QueueDeviceSource } from "../storage/queued-message-store"
import type { SettingsService } from "../services/settings"

const key = "mobile.devices"
const recordsSchema = pairedDeviceSchema.array()
const desktopPlatforms = new Set<string>(desktopPlatformSchema.options)

export function deviceRoleOf(device: Pick<PairedDevice, "role" | "platform">): ClientRole {
  if (device.role === "mobile" || device.role === "desktop") return device.role
  return desktopPlatforms.has(device.platform) ? "desktop" : "mobile"
}

function authorizationId(device: PairedDevice): string {
  return device.authorizationId ?? "legacy"
}

export function queueSourceAuthorized(
  settings: SettingsService | undefined,
  source: QueueDeviceSource,
): boolean {
  const records = recordsSchema.safeParse(settings?.get(key))
  const record = records.success
    ? records.data.find(({ publicKey }) => publicKey === source.deviceKey)
    : undefined
  return record != null && authorizationId(record) === source.authorizationId
}

export function fingerprint(publicKey: Buffer): string {
  return createHash("sha256").update(publicKey).digest("hex")
}

export function pairedDeviceId(publicKey: string): string {
  return fingerprint(Buffer.from(publicKey, "base64url"))
}

export class PairedDevices {
  private records: PairedDevice[]
  private readonly runAuthorizations = new Map<string, symbol>()

  constructor(private readonly settings: SettingsService) {
    const parsed = recordsSchema.safeParse(settings.get(key))
    this.records = parsed.success ? parsed.data : []
  }

  get size(): number {
    return this.records.length
  }

  countByRole(role: ClientRole): number {
    return this.records.filter((record) => deviceRoleOf(record) === role).length
  }

  find(publicKey: string): PairedDevice | undefined {
    return this.records.find((device) => device.publicKey === publicKey)
  }

  findById(id: string, role?: ClientRole): PairedDevice | undefined {
    return this.records.find(
      (record) =>
        pairedDeviceId(record.publicKey) === id && (!role || deviceRoleOf(record) === role),
    )
  }

  /** 返回已配对手机设备列表（仅 `role === "mobile"`，永不混入远程桌面）。 */
  view(revision: string | undefined, connected: ReadonlySet<string>): MobilePairingView["devices"] {
    return this.records
      .filter((record) => deviceRoleOf(record) === "mobile")
      .map(({ publicKey, name, platform, lastConnectedAt, relayRevision, reminders, apns }) => ({
        name,
        platform: devicePlatformSchema.parse(platform),
        lastConnectedAt,
        id: pairedDeviceId(publicKey),
        connected: connected.has(publicKey),
        needsRelayUpdate: revision !== undefined && revision !== relayRevision,
        ...(reminders ? { reminders } : {}),
        ...(apns ? { pushRegistered: true } : {}),
      }))
  }

  /** 返回已授权接入本机的远程桌面客户端列表（仅 `role === "desktop"`）。 */
  desktopView(connected: ReadonlySet<string>): DesktopAuthorizedClient[] {
    return this.records
      .filter((record) => deviceRoleOf(record) === "desktop")
      .map(({ publicKey, name, platform, lastConnectedAt }) => ({
        id: pairedDeviceId(publicKey),
        name,
        platform: desktopPlatformSchema.parse(platform),
        lastConnectedAt,
        connected: connected.has(publicKey),
      }))
  }

  reportReminders(
    publicKey: string,
    { enabled, permission }: MobileReminderSettings,
    apns?: PairedDevice["apns"],
  ): void {
    const device = this.find(publicKey)
    if (device && deviceRoleOf(device) === "mobile") {
      const { apns: savedApns, ...current } = device
      const target = enabled && permission === "granted" ? (apns ?? savedApns) : undefined
      this.save({
        ...current,
        ...(target ? { apns: target } : {}),
        reminders: { enabled, permission, syncedAt: Date.now() },
      })
    }
  }

  reminderTargets(): readonly PairedDevice[] {
    return this.records.filter(
      (device) =>
        deviceRoleOf(device) === "mobile" &&
        device.apns &&
        device.reminders?.enabled &&
        device.reminders.permission === "granted",
    )
  }

  save(device: PairedDevice): void {
    const existing = this.find(device.publicKey)
    this.replace([
      ...this.records.filter(({ publicKey }) => publicKey !== device.publicKey),
      {
        ...device,
        role: deviceRoleOf(device),
        authorizationId: existing ? existing.authorizationId : randomUUID(),
      },
    ])
  }

  remove(device: PairedDevice): void {
    this.replace(this.records.filter(({ publicKey }) => publicKey !== device.publicKey))
    this.runAuthorizations.delete(device.publicKey)
  }

  runAuthorization(publicKey: string): () => boolean {
    const permit = this.runAuthorizations.get(publicKey) ?? Symbol()
    this.runAuthorizations.set(publicKey, permit)
    return () => this.runAuthorizations.get(publicKey) === permit && !!this.find(publicKey)
  }

  queueSource(publicKey: string): QueueDeviceSource | undefined {
    const device = this.find(publicKey)
    return device ? { deviceKey: publicKey, authorizationId: authorizationId(device) } : undefined
  }

  acknowledgeRelay(publicKey: string, revision: string): void {
    const device = this.find(publicKey)
    if (device?.confirmedRelayRevision === revision && device.relayRevision !== revision) {
      this.save({ ...device, relayRevision: revision })
    }
  }

  private replace(records: PairedDevice[]): void {
    this.settings.set(key, records)
    this.records = records
  }
}
