import type { Context } from "cordis"
import { cleanupDeviceMobileAttachments } from "./attachments"
import type { acceptNoise } from "./noise"

export const deviceRevokedNotice = { type: "device.revoked" } as const

export function tellRevokedDevice(negotiated: boolean | undefined, send: () => void): void {
  if (!negotiated) return
  try {
    send()
  } catch {
    // The device can get an authenticated denial on its next connection.
  }
}

export function denyUnpairedDevice(
  optedIn: boolean | undefined,
  handshake: ReturnType<typeof acceptNoise>,
  send: (message: Buffer) => void,
): void {
  if (!optedIn) throw new Error("unpaired device")
  send(handshake.reply(Buffer.from(JSON.stringify(deviceRevokedNotice))).message)
}

export function revokeDeviceWork(ctx: Context, publicKey: string): void {
  ctx.agents.cancelDeviceQueuedRuns(publicKey)
  try {
    ctx.get("messageQueue")?.revoke(publicKey)
  } catch (error) {
    // Dispatch still checks durable authorization before starting a message.
    console.error("[host] could not remove messages of revoked device", error)
  }
  try {
    cleanupDeviceMobileAttachments(ctx, publicKey)
  } catch (error) {
    console.error("[host] could not remove staging attachments of revoked device", error)
  }
}
