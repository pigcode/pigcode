import { createHash, randomUUID } from "node:crypto"
import type { HostReminder, MobileReminderSettings } from "@pigcode/contracts"
import type { Context } from "cordis"
import { attachHostReminders } from "../rpc/host-reminders"
import type { RelayCredentialCipher } from "../services/relay-settings"
import { pairedDeviceId, type PairedDevices } from "./paired-devices"
import type { RelayHost, RelayPushIdentity } from "./relay-host"
import type { NoiseKeyPair } from "./noise"

export class MobilePushReminders {
  private readonly pending = new Map<string, symbol>()

  constructor(
    ctx: Context,
    private readonly devices: PairedDevices,
    private readonly cipher: RelayCredentialCipher,
    private readonly relay: () => RelayHost | undefined,
  ) {
    attachHostReminders(ctx, (reminder) => this.send(reminder))
  }

  proveIdentity(identity: NoiseKeyPair, active: () => boolean): RelayPushIdentity {
    return {
      identity,
      invalidated: (deviceId, registrationId) => {
        if (active()) this.invalidate(deviceId, registrationId)
      },
    }
  }

  async report(publicKey: string, settings: MobileReminderSettings): Promise<boolean> {
    const device = this.devices.find(publicKey)
    if (!device) return false
    const authorized = this.devices.runAuthorization(publicKey)
    const report = Symbol()
    this.pending.set(publicKey, report)
    try {
      const registration = settings.enabled && settings.permission === "granted" &&
        device.platform === "ios" ? settings.apns : undefined
      if (!registration) {
        this.devices.reportReminders(publicKey, settings)
        return true
      }
      const { environment, token, observationId } = registration
      const fingerprint = createHash("sha256").update(environment).update("\0").update(token).digest("hex")
      if (device.invalidApns?.fingerprint === fingerprint &&
          device.invalidApns.observationId === observationId) {
        this.devices.reportReminders(publicKey, settings)
        return true
      }
      if (device.apns?.fingerprint === fingerprint) {
        const target = device.apns
        this.devices.reportReminders(publicKey, settings, target.observationId === observationId
          ? target
          : { ...target, observationId, registrationId: randomUUID() })
        return true
      }
      const sealedToken = await this.cipher.seal(registration.token)
      if (!authorized() || this.pending.get(publicKey) !== report) return false
      this.devices.reportReminders(publicKey, settings, {
        registrationId: randomUUID(), environment, sealedToken, fingerprint, observationId,
      })
      return true
    } catch {
      throw new Error("could not store the APNs registration")
    } finally {
      if (this.pending.get(publicKey) === report) this.pending.delete(publicKey)
    }
  }

  private invalidate(deviceId: string, registrationId: string): void {
    const device = this.devices.findById(deviceId)
    if (!device) return
    const { apns, ...current } = device
    if (apns?.registrationId !== registrationId) return
    try {
      this.devices.save({
        ...current,
        invalidApns: { fingerprint: apns.fingerprint, observationId: apns.observationId },
      })
    } catch {
      console.error("[host] could not remove the invalid APNs registration")
    }
  }

  private send(reminder: HostReminder): void {
    const relay = this.relay()
    if (!relay) return
    for (const { publicKey, apns } of this.devices.reminderTargets()) {
      if (!apns || !relay.supportsPush(apns.environment)) continue
      void this.cipher.open(apns.sealedToken).then((token) => {
        const device = this.devices.find(publicKey)
        if (this.relay() !== relay || device?.apns?.registrationId !== apns.registrationId ||
            !device.reminders?.enabled || device.reminders.permission !== "granted") return
        relay.sendReminder({
          deviceId: pairedDeviceId(publicKey), registrationId: apns.registrationId,
          environment: apns.environment, token,
        }, reminder)
      }).catch(() => console.error("[host] could not submit the APNs reminder"))
    }
  }
}
