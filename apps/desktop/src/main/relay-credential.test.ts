import { EventEmitter } from "node:events"
import type { MessagePortMain } from "electron"
import { expect, it, vi } from "vitest"
import { attachRelayCredentials } from "./relay-credential"

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome-libsecret",
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  },
}))

function credentialPort(profile: string) {
  const port = Object.assign(new EventEmitter(), { start: vi.fn(), postMessage: vi.fn() })
  attachRelayCredentials(port as unknown as MessagePortMain, profile)
  return (action: "seal" | "open", value: string) => {
    port.emit("message", { data: { type: "relay.credential", id: "test", action, value } })
    return (port.postMessage.mock.lastCall?.[0] as { value: string | null }).value
  }
}

it("only opens saved relay credentials in the Host profile which sealed them", () => {
  const first = credentialPort("/profiles/first")
  const second = credentialPort("/profiles/second")
  const sealed = first("seal", "example-relay-token")
  expect(sealed).toEqual(expect.any(String))
  expect(first("open", sealed!)).toBe("example-relay-token")
  expect(second("open", sealed!)).toBeNull()
})
