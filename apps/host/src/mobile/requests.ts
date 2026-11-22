import { mobileRelaySavedSchema, parseRpcRequest } from "@pigcode/contracts"
import { fingerprint, type PairedDevices } from "./paired-devices"

/** Process messages after the phone has authenticated and negotiated the session. */
export function respondToMobile(
  devices: PairedDevices,
  session: {
    computerKey: Buffer
    computerName: string
    deviceKey: string
    features: readonly string[]
    relayRevision: string | undefined
  },
  message: unknown,
) {
  const receipt = mobileRelaySavedSchema.safeParse(message)
  if (receipt.success) {
    if (
      session.features.includes("relay.saveReceipt") &&
      receipt.data.relayRevision === session.relayRevision
    ) {
      devices.acknowledgeRelay(session.deviceKey, receipt.data.relayRevision)
    }
    return
  }

  const request = parseRpcRequest(message)
  const response = { jsonrpc: "2.0", id: request.id }
  if (request.method === "mobile.status" && session.features.includes("connection.status")) {
    return {
      ...response,
      result: {
        computerId: fingerprint(session.computerKey),
        computerName: session.computerName,
        deviceId: fingerprint(Buffer.from(session.deviceKey, "base64url")),
      },
    }
  }
  return {
    ...response,
    error: { code: "METHOD_NOT_AVAILABLE", message: "Method not available", retryable: false },
  }
}
