import { createHash, randomUUID } from "node:crypto"
import { pairedDeviceSchema, type MobilePairingView, type MobileReminderSettings, type PairedDevice } from "@pigcode/contracts"
import type { QueueDeviceSource } from "../storage/queued-message-store"
import type { SettingsService } from "../services/settings"

const key = "mobile.devices"
const recordsSchema = pairedDeviceSchema.array()

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

function deviceId(publicKey: string): string {
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

  find(publicKey: string): PairedDevice | undefined {
    return this.records.find((device) => device.publicKey === publicKey)
  }

  findById(id: string): PairedDevice | undefined {
    return this.records.find(({ publicKey }) => deviceId(publicKey) === id)
  }

  view(revision: string | undefined, connected: ReadonlySet<string>): MobilePairingView["devices"] {
    return this.records.map(({ publicKey, name, platform, lastConnectedAt, relayRevision, reminders }) => ({
      name,
      platform,
      lastConnectedAt,
      id: deviceId(publicKey),
      connected: connected.has(publicKey),
      needsRelayUpdate: revision !== undefined && revision !== relayRevision,
      ...(reminders ? { reminders } : {}),
    }))
  }

  reportReminders(publicKey: string, settings: MobileReminderSettings): void {
    const device = this.find(publicKey)
    if (device) this.save({ ...device, reminders: { ...settings, syncedAt: Date.now() } })
  }

  save(device: PairedDevice): void {
    const existing = this.find(device.publicKey)
    this.replace([
      ...this.records.filter(({ publicKey }) => publicKey !== device.publicKey),
      { ...device, authorizationId: existing ? existing.authorizationId : randomUUID() },
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
