import { resolve } from "node:path"
import { relayCredentialRequestSchema } from "@pigcode/contracts"
import { safeStorage, type MessagePortMain } from "electron"

/** Host persists the encrypted token together with its address in one settings write. */
export function attachRelayCredentials(port: MessagePortMain, profileDir: string): void {
  const profile = resolve(profileDir)
  port.on("message", ({ data }) => {
    const request = relayCredentialRequestSchema.safeParse(data)
    if (!request.success) return
    const { id, action, value } = request.data
    let result: string | null = null
    try {
      if (safeStorage.isEncryptionAvailable()) {
        const backend =
          process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : null
        if (backend !== "basic_text" && backend !== "unknown") {
          if (action === "seal") {
            result = safeStorage
              .encryptString(JSON.stringify({ profile, token: value }))
              .toString("base64")
          } else {
            const stored = JSON.parse(safeStorage.decryptString(Buffer.from(value, "base64"))) as {
              profile?: unknown
              token?: unknown
            } | null
            if (stored?.profile === profile && typeof stored.token === "string") {
              result = stored.token
            }
          }
        }
      }
    } catch {
      // Relay settings get a stable error, without including entered credentials.
    }
    port.postMessage({ type: "relay.credential.result", id, value: result })
  })
  port.start()
}
