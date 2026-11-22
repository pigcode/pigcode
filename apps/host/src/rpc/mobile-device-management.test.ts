import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { mobilePairingViewSchema, pairingCodeSchema, rpcSuccessSchema } from "@pigcode/contracts"
import { expect, it } from "vitest"
import { startMobileHost } from "./mobile-test-fixture"

it("removes only the selected device and keeps it removed after a Host restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pigcode-revoke-test-"))
  const settingsPath = join(directory, "settings.json")
  const first = Buffer.alloc(32, 1)
  const second = Buffer.alloc(32, 2)
  const deviceId = createHash("sha256").update(first).digest("hex")
  writeFileSync(
    settingsPath,
    JSON.stringify({
      "mobile.devices": [
        {
          publicKey: first.toString("base64url"),
          name: "个人 iPhone",
          platform: "ios",
          lastConnectedAt: 1000,
        },
        {
          publicKey: second.toString("base64url"),
          name: "工作 Android",
          platform: "android",
          lastConnectedAt: 2000,
        },
      ],
    }),
  )
  try {
    const host = await startMobileHost({ settingsPath })
    try {
      expect(await host.call("mobile.devices.revoke", { deviceId })).toMatchObject({
        result: { status: "revoked" },
      })
      expect(await host.call("mobile.pairing")).toMatchObject({
        result: {
          devices: [
            {
              name: "工作 Android",
              platform: "android",
              lastConnectedAt: 2000,
              needsRelayUpdate: false,
            },
          ],
        },
      })
    } finally {
      await host.stop()
    }

    const reopened = await startMobileHost({ settingsPath })
    try {
      expect(await reopened.call("mobile.pairing")).toMatchObject({
        result: { devices: [{ name: "工作 Android" }] },
      })
    } finally {
      await reopened.stop()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

const oldAddress = process.env.PIGCODE_RELAY_TEST_URL
const oldToken = process.env.PIGCODE_RELAY_TEST_TOKEN
const newAddress = process.env.PIGCODE_RELAY_NEXT_TEST_URL
const newToken = process.env.PIGCODE_RELAY_NEXT_TEST_TOKEN

it.skipIf(!oldAddress || !oldToken || !newAddress || !newToken)(
  "updates paired Dart phones across two Go relays and revokes only the selected authorization",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "pigcode-device-test-"))
    const settingsPath = join(directory, "settings.json")
    let host = await startMobileHost({ settingsPath })
    const dart = spawn("dart", ["run", "scripts/verify-device-management.dart"], {
      cwd: fileURLToPath(new URL("../../../mobile", import.meta.url)),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let diagnostics = ""
    dart.stderr.setEncoding("utf8")
    dart.stderr.on("data", (chunk: string) => (diagnostics += chunk))
    dart.on("error", (error) => (diagnostics += error.message))
    const lines = createInterface({ input: dart.stdout })[Symbol.asyncIterator]()
    const first = "个人 iPhone"
    const second = "工作 Android"

    async function call(method: string, params?: Record<string, unknown>) {
      return rpcSuccessSchema.parse(await host.call(method, params)).result
    }
    async function view() {
      return mobilePairingViewSchema.parse(await call("mobile.pairing"))
    }
    async function openPairing() {
      const result = mobilePairingViewSchema.parse(await call("mobile.pairing.start"))
      const attempt = result.attempt
      if (!attempt?.qr) throw new Error("expected a pairing QR")
      return {
        id: attempt.id,
        qr: attempt.qr,
        invite: pairingCodeSchema.parse(JSON.parse(attempt.qr)),
      }
    }
    async function readPhone() {
      const entry = await lines.next()
      if (entry.done) throw new Error(diagnostics || "Dart verification exited early")
      return JSON.parse(entry.value) as { stage: string; code?: string; address?: string }
    }
    function sendPhone(action: string, phone: string, qr?: string) {
      dart.stdin.write(JSON.stringify({ action, phone, qr }) + "\n")
    }
    async function approve(
      action: "pair" | "update",
      name: string,
      finish: "save" | "cancel" | "hold" = "save",
    ) {
      const attempt = await openPairing()
      sendPhone(action, name, attempt.qr)
      const proof = await readPhone()
      expect(proof.stage).toBe("code")
      const pending = (await view()).attempt?.candidate
      expect(pending).toMatchObject({
        name,
        code: proof.code,
        mode: action,
      })
      if (finish === "cancel") {
        await call("mobile.pairing.cancel", { id: attempt.id })
        expect(await readPhone()).toMatchObject({ stage: "failed" })
      } else {
        await call("mobile.pairing.confirm", {
          id: attempt.id,
          confirmation: pending?.confirmation,
        })
        expect(await readPhone()).toEqual({ stage: "ready" })
        if (finish === "save") {
          sendPhone("save", name)
          expect(await readPhone()).toEqual({ stage: "saved" })
          await expect
            .poll(
              async () =>
                (await view()).devices.find((device) => device.name === name)?.needsRelayUpdate,
            )
            .toBe(false)
        }
      }
      return attempt.invite
    }

    try {
      expect(
        await call("relay.testAndSave", { address: oldAddress, token: oldToken }),
      ).toMatchObject({
        status: "saved",
      })
      const original = await approve("pair", first)
      await approve("pair", second)
      const devices = (await view()).devices
      const phoneA = devices.find((device) => device.name === first)
      const phoneB = devices.find((device) => device.name === second)
      if (!phoneA || !phoneB) throw new Error("both phones must be paired")
      expect(devices).toMatchObject([
        { connected: true, needsRelayUpdate: false },
        { connected: true, needsRelayUpdate: false },
      ])

      expect(
        await call("relay.testAndSave", { address: oldAddress, token: oldToken }),
      ).toMatchObject({
        status: "saved",
      })
      expect((await view()).devices.every((device) => device.connected)).toBe(true)
      expect(
        await call("relay.testAndSave", { address: newAddress, token: "wrong-test-token" }),
      ).toMatchObject({
        status: "token-rejected",
      })
      expect(
        (await view()).devices.every((device) => device.connected && !device.needsRelayUpdate),
      ).toBe(true)
      expect(
        await call("relay.testAndSave", { address: newAddress, token: newToken }),
      ).toMatchObject({
        status: "saved",
      })
      for (const phone of [first, second]) {
        sendPhone("closed", phone)
        expect(await readPhone()).toEqual({ stage: "closed" })
      }
      expect(
        (await view()).devices.every((device) => !device.connected && device.needsRelayUpdate),
      ).toBe(true)

      const mismatched = await openPairing()
      sendPhone(
        "update",
        first,
        JSON.stringify({
          ...mismatched.invite,
          computerKey: Buffer.alloc(32, 3).toString("base64url"),
        }),
      )
      expect(await readPhone()).toEqual({ stage: "failed", code: "computer-key-changed" })
      expect((await view()).attempt?.candidate).toBeNull()
      await call("mobile.pairing.cancel", { id: mismatched.id })

      const canceled = await approve("update", first, "cancel")
      expect(canceled.computerKey).toBe(original.computerKey)
      sendPhone("saved", first)
      expect(await readPhone()).toEqual({ stage: "saved", address: oldAddress })
      const updated = await approve("update", first, "hold")
      expect(updated.computerKey).toBe(original.computerKey)
      expect((await view()).devices.find(({ id }) => id === phoneA.id)?.needsRelayUpdate).toBe(true)
      sendPhone("saved", first)
      expect(await readPhone()).toEqual({ stage: "saved", address: oldAddress })

      sendPhone("saveWithoutReceipt", first)
      expect(await readPhone()).toEqual({ stage: "saved" })
      expect((await view()).devices.find(({ id }) => id === phoneA.id)?.needsRelayUpdate).toBe(true)
      await host.stop()
      host = await startMobileHost({ settingsPath })
      const registration = await openPairing()
      await call("mobile.pairing.cancel", { id: registration.id })
      sendPhone("reconnect", first)
      expect(await readPhone()).toEqual({ stage: "ready" })
      await expect
        .poll(
          async () => (await view()).devices.find(({ id }) => id === phoneA.id)?.needsRelayUpdate,
        )
        .toBe(false)
      sendPhone("saved", first)
      expect(await readPhone()).toEqual({ stage: "saved", address: newAddress })
      expect((await view()).devices).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: phoneA.id,
            name: first,
            connected: true,
            needsRelayUpdate: false,
          }),
          expect.objectContaining({
            id: phoneB.id,
            name: second,
            connected: false,
            needsRelayUpdate: true,
          }),
        ]),
      )
      await approve("update", second)

      expect(await call("mobile.devices.revoke", { deviceId: phoneA.id })).toMatchObject({
        status: "revoked",
      })
      sendPhone("revoked", first)
      expect(await readPhone()).toEqual({ stage: "revoked", confirmed: true })
      sendPhone("reconnect", first)
      expect(await readPhone()).toMatchObject({ stage: "failed", code: "device-revoked" })
      const revokedUpdate = await openPairing()
      sendPhone("update", first, revokedUpdate.qr)
      expect(await readPhone()).toMatchObject({ stage: "failed" })
      expect((await view()).attempt?.candidate).toBeNull()
      await call("mobile.pairing.cancel", { id: revokedUpdate.id })
      expect((await view()).devices).toMatchObject([{ id: phoneB.id, connected: true }])

      await host.stop()
      host = await startMobileHost({ settingsPath })
      expect((await view()).devices).toMatchObject([{ id: phoneB.id, needsRelayUpdate: false }])
      const active = await openPairing()
      await call("mobile.pairing.cancel", { id: active.id })
      sendPhone("reconnect", second)
      expect(await readPhone()).toEqual({ stage: "ready" })
      sendPhone("reconnect", first)
      expect(await readPhone()).toMatchObject({ stage: "failed", code: "device-revoked" })

      await openPairing()
      expect(await call("mobile.devices.revoke", { deviceId: phoneB.id })).toMatchObject({
        status: "revoked",
        pairing: { attempt: null },
      })
      sendPhone("revoked", second)
      expect(await readPhone()).toEqual({ stage: "revoked", confirmed: true })
      sendPhone("reconnect", second)
      expect(await readPhone()).toEqual({ stage: "failed", code: "offline" })
      expect((await view()).devices).toEqual([])
      expect((await approve("pair", second)).computerKey).toBe(original.computerKey)
    } finally {
      dart.stdin.end()
      dart.kill()
      try {
        await host.stop()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  },
  45_000,
)
