import { createHash } from "node:crypto"
import { pairedDeviceSchema, type MobilePairingView, type PairedDevice } from "@pigcode/contracts"
import type { SettingsService } from "../services/settings"

const key = "mobile.devices"
const recordsSchema = pairedDeviceSchema.array()

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
    return this.records.map(({ publicKey, name, platform, lastConnectedAt, relayRevision }) => ({
      name,
      platform,
      lastConnectedAt,
      id: deviceId(publicKey),
      connected: connected.has(publicKey),
      needsRelayUpdate: revision !== undefined && revision !== relayRevision,
    }))
  }

  save(device: PairedDevice): void {
    this.replace([
      ...this.records.filter(({ publicKey }) => publicKey !== device.publicKey),
      device,
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
