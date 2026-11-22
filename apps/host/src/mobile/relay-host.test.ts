import { readFileSync } from "node:fs"
import {
  relayAdmissionSchema,
  relayRegistrationSchema,
  relaySessionControlSchema,
} from "@pigcode/contracts"
import { expect, it } from "vitest"

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
  expect(relayAdmissionSchema.parse(fixture.admitted).status).toBe("ok")
  expect(relayAdmissionSchema.parse(fixture.offline).status).toBe("offline")
  const { session } = relaySessionControlSchema.parse(fixture.open)
  expect(relaySessionControlSchema.parse(fixture.close)).toEqual({ type: "relay.close", session })
  const frame = Buffer.from(fixture.hostFrameHex, "hex")
  expect(frame.readUInt32BE(0)).toBe(session)
  expect(frame.subarray(4).toString("hex")).toBe(fixture.ciphertextHex)
})
