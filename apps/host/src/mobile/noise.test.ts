import { readFileSync } from "node:fs"
import { expect, it } from "vitest"
import { acceptNoise, beginNoise, noiseKeyPair } from "./noise"

const vector = JSON.parse(
  readFileSync(
    new URL("../../../../packages/contracts/fixtures/noise-ik-v1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, string>

it("matches the reference Noise IK handshake and both transport directions", () => {
  const bytes = (key: string) => Buffer.from(vector[key] ?? "", "hex")
  const host = noiseKeyPair(bytes("resp_static"))
  const phone = noiseKeyPair(bytes("init_static"))
  const initiation = beginNoise(phone, host.publicKey, bytes("msg_0_payload"), {
    prologue: Buffer.alloc(0),
    ephemeral: noiseKeyPair(bytes("gen_init_ephemeral")),
  })
  expect(initiation.message).toEqual(bytes("msg_0_ciphertext"))
  const acceptance = acceptNoise(host, initiation.message, {
    prologue: Buffer.alloc(0),
    ephemeral: noiseKeyPair(bytes("gen_resp_ephemeral")),
  })
  expect(acceptance.publicKey).toEqual(phone.publicKey)
  expect(acceptance.payload).toEqual(bytes("msg_0_payload"))
  const response = acceptance.reply(bytes("msg_1_payload"))
  expect(response.message).toEqual(bytes("msg_1_ciphertext"))
  const { session, payload } = initiation.finish(response.message)
  expect(payload).toEqual(bytes("msg_1_payload"))
  expect(session.verificationCode).toBe(response.session.verificationCode)
  expect(session.encrypt(bytes("msg_2_payload"))).toEqual(bytes("msg_2_ciphertext"))
  expect(response.session.decrypt(bytes("msg_2_ciphertext"))).toEqual(bytes("msg_2_payload"))
  expect(response.session.encrypt(bytes("msg_3_payload"))).toEqual(bytes("msg_3_ciphertext"))
  expect(session.decrypt(bytes("msg_3_ciphertext"))).toEqual(bytes("msg_3_payload"))
})
