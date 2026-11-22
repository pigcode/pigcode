import { readFileSync } from "node:fs"
import {
  RELAY_HEARTBEAT_SECONDS,
  relayAdmissionSchema,
  relayComputerStatusSchema,
  relayRegistrationSchema,
  relaySessionControlSchema,
  relayWatchSchema,
} from "@pigcode/contracts"
import { expect, it, vi } from "vitest"
import { openRelayHost } from "./relay-host"

it("reads the shared Go routing controls and binary frame", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("../../../../packages/contracts/fixtures/relay-route-v1.json", import.meta.url),
      "utf8",
    ),
  )
  const host = relayRegistrationSchema.parse(fixture.host)
  const phone = relayRegistrationSchema.parse(fixture.phone)
  expect(host.type).toBe("relay.host")
  expect(phone.type).toBe("relay.phone")
  expect(phone.computerId).toBe(host.computerId)
  expect(relayWatchSchema.parse(fixture.watch).computerId).toBe(host.computerId)
  expect(relayAdmissionSchema.parse(fixture.admitted).status).toBe("ok")
  expect(relayAdmissionSchema.parse(fixture.admittedWithHeartbeat).heartbeatSeconds).toBe(RELAY_HEARTBEAT_SECONDS)
  expect(relayAdmissionSchema.parse(fixture.offline).status).toBe("offline")
  expect(relayComputerStatusSchema.parse(fixture.neverOnline).lastOnlineAt).toBeNull()
  expect(relayComputerStatusSchema.parse(fixture.sleeping)).toMatchObject({ state: "sleeping", lastOnlineAt: 1795392000000 })
  const { session } = relaySessionControlSchema.parse(fixture.open)
  expect(relaySessionControlSchema.parse(fixture.close)).toEqual({ type: "relay.close", session })
  const frame = Buffer.from(fixture.hostFrameHex, "hex")
  expect(frame.readUInt32BE(0)).toBe(session)
  expect(frame.subarray(4).toString("hex")).toBe(fixture.ciphertextHex)
})

it("marks the relay down two intervals after a pong that arrived between ticks", async () => {
  class TestSocket extends EventTarget {
    static OPEN = 1
    static instances: TestSocket[] = []
    readyState = TestSocket.OPEN
    send = vi.fn()
    close = vi.fn()
    constructor() {
      super()
      TestSocket.instances.push(this)
    }
    reply(message: object) {
      this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }))
    }
  }
  vi.useFakeTimers()
  vi.stubGlobal("WebSocket", TestSocket)
  const disconnected = vi.fn()
  try {
    const joining = openRelayHost(
      { address: "wss://relay.test/ws/v1/connect", token: "fixture" },
      "a".repeat(64),
      { sessionOpened: vi.fn(), sessionClosed: vi.fn(), received: vi.fn(), disconnected },
      new AbortController().signal,
    )
    const socket = TestSocket.instances[0]!
    socket.reply({ type: "relay.result", version: 1, status: "ok", heartbeatSeconds: 25 })
    await joining
    await vi.advanceTimersByTimeAsync(25_300)
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "relay.ping" }))
    socket.reply({ type: "relay.pong" })
    await vi.advanceTimersByTimeAsync(49_999)
    expect(disconnected).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(disconnected).toHaveBeenCalledTimes(1)
    expect(socket.close).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
