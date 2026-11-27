import { describe, expect, it } from "vitest"
import {
  deviceHandshakeSchema,
  encodeDesktopPairingLink,
  pairedDeviceSchema,
  parseDesktopPairingInput,
} from "./index"

const HOST_KEY = "A".repeat(43)
const SECRET = "B".repeat(43)

describe("desktop pairing contracts", () => {
  it("encodes and parses self-contained pigcode://pair link with relay credentials", () => {
    const payload = {
      type: "pigcode.desktopPair" as const,
      version: 1 as const,
      address: "wss://relay.example.com/ws/v1/connect",
      token: "relay-secret-token",
      lanAddresses: ["ws://192.168.1.20:39871/ws"],
      hostKey: HOST_KEY,
      hostName: "home-linux-nas",
      secret: SECRET,
      expiresAt: 1_800_000_000_000,
    }
    const link = encodeDesktopPairingLink(payload)
    expect(link.startsWith("pigcode://pair?v=1&d=")).toBe(true)

    const parsed = parseDesktopPairingInput(`  ${link}\n`)
    expect(parsed).toEqual({ ok: true, payload })

    const parsedRaw = parseDesktopPairingInput(JSON.stringify(payload))
    expect(parsedRaw).toEqual({ ok: true, payload })
  })

  it("supports LAN-only desktop pairing payload when relay is unconfigured", () => {
    const link = encodeDesktopPairingLink({
      type: "pigcode.desktopPair",
      version: 1,
      address: null,
      token: null,
      lanAddresses: ["ws://10.0.0.12:39871/ws"],
      hostKey: HOST_KEY,
      hostName: "lab-box",
      secret: SECRET,
      expiresAt: 1_800_000_000_000,
    })
    const parsed = parseDesktopPairingInput(link)
    expect(parsed.ok).toBe(true)
  })

  it("explicitly distinguishes and rejects mobile QR payload vs invalid text", () => {
    const mobileQr = JSON.stringify({
      type: "pigcode.pair",
      version: 1,
      address: "wss://relay.example.com/ws/v1/connect",
      token: "t",
      computerKey: HOST_KEY,
      computerName: "MyMac",
      secret: SECRET,
      expiresAt: 1_800_000_000_000,
    })
    expect(parseDesktopPairingInput(mobileQr)).toEqual({ ok: false, code: "mobile-only" })
    expect(parseDesktopPairingInput("")).toEqual({ ok: false, code: "empty" })
    expect(parseDesktopPairingInput("pigcode://pair?v=2&d=abc")).toEqual({
      ok: false,
      code: "invalid",
    })
    expect(parseDesktopPairingInput("K7Q9-2XFD")).toEqual({ ok: false, code: "invalid" })
  })

  it("enforces role/platform compatibility and legacy mobile default on paired devices", () => {
    expect(
      deviceHandshakeSchema.safeParse({
        type: "device.pair",
        role: "desktop",
        secret: SECRET,
        name: "Work MacBook",
        platform: "macos",
      }).success,
    ).toBe(true)

    expect(
      deviceHandshakeSchema.safeParse({
        type: "device.pair",
        role: "desktop",
        secret: SECRET,
        name: "Phone",
        platform: "ios",
      }).success,
    ).toBe(false)

    expect(
      deviceHandshakeSchema.safeParse({
        type: "device.pair",
        secret: SECRET,
        name: "iPhone",
        platform: "ios",
      }).success,
    ).toBe(true)

    expect(
      deviceHandshakeSchema.safeParse({
        type: "device.pair",
        role: "mobile",
        secret: SECRET,
        name: "Fake",
        platform: "linux",
      }).success,
    ).toBe(false)

    const legacy = pairedDeviceSchema.parse({
      publicKey: HOST_KEY,
      name: "Legacy Phone",
      platform: "ios",
      lastConnectedAt: null,
    })
    expect(legacy.role ?? "mobile").toBe("mobile")
  })
})
