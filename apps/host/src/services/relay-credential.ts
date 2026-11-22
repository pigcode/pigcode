import { randomUUID } from "node:crypto"
import type { HostTransport } from "@pigcode/client-runtime/transport"
import { relayCredentialResultSchema } from "@pigcode/contracts"
import type { RelayCredentialCipher } from "./relay-settings"

/** Keep system credential operations on the desktop control port. */
export function desktopRelayCipher(transport: HostTransport): RelayCredentialCipher {
  function transform(action: "seal" | "open", value: string): Promise<string> {
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new Error("relay credential storage did not respond"))
      }, 5_000)
      const unsubscribe = transport.onMessage((message) => {
        const reply = relayCredentialResultSchema.safeParse(message)
        if (!reply.success || reply.data.id !== id) return
        clearTimeout(timeout)
        unsubscribe()
        if (reply.data.value === null) reject(new Error("relay credential storage is unavailable"))
        else resolve(reply.data.value)
      })
      try {
        transport.send({ type: "relay.credential", id, action, value })
      } catch (error) {
        clearTimeout(timeout)
        unsubscribe()
        reject(error)
      }
    })
  }
  return { seal: (value) => transform("seal", value), open: (value) => transform("open", value) }
}
