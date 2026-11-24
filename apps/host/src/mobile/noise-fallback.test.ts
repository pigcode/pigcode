import { readFileSync } from "node:fs"
import { expect, it, vi } from "vitest"

// Electron 的 Node 没有 OpenSSL 的 chacha20-poly1305。让创建 cipher 时抛错，
// 模拟 Electron 环境，确认走纯 JS 实现后的握手和密文仍与参考向量一致。
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>()
  const unsupported = () => {
    throw new Error("Unknown cipher")
  }
  return { ...actual, createCipheriv: unsupported, createDecipheriv: unsupported }
})

const { acceptNoise, beginNoise, noiseKeyPair } = await import("./noise")
const vector = JSON.parse(
  readFileSync(
    new URL("../../../../packages/contracts/fixtures/noise-ik-v1.json", import.meta.url),
    "utf8",
  ),
) as Record<string, string>

it("matches the reference Noise IK handshake without the OpenSSL cipher", () => {
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
