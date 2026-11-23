import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { mobilePairingViewSchema, rpcSuccessSchema } from "@pigcode/contracts"
import { expect, it } from "vitest"
import { FAKE_FAIL_TEXT } from "../agents/fake"
import { startMobileHost } from "./mobile-test-fixture"

const address = process.env.PIGCODE_PUSH_TEST_URL
const relayToken = process.env.PIGCODE_PUSH_TEST_RELAY_TOKEN
const deliveriesPath = process.env.PIGCODE_PUSH_TEST_RECORDS
const fixtureIdentity = process.env.PIGCODE_PUSH_TEST_HOST_SEED

it.skipIf(!address || !relayToken || !deliveriesPath || !fixtureIdentity)(
  "sends reminders only to current paired iPhones and applies APNs invalidation over Go WSS",
  async () => {
    const profile = mkdtempSync(join(tmpdir(), "pigcode-push-host-"))
    const settingsPath = join(profile, "settings.json")
    const sealedIdentity = Buffer.from(JSON.stringify([randomUUID(), fixtureIdentity])).toString("base64")
    writeFileSync(settingsPath, JSON.stringify({ "mobile.identity": sealedIdentity }))
    let host = await startMobileHost({ settingsPath })
    const dart = spawn("dart", ["run", "scripts/verify-device-management.dart"], {
      cwd: fileURLToPath(new URL("../../../mobile", import.meta.url)),
      stdio: ["pipe", "pipe", "pipe"],
    })
    let diagnostics = ""
    dart.stderr.setEncoding("utf8").on("data", (chunk: string) => (diagnostics += chunk))
    const lines = createInterface({ input: dart.stdout })[Symbol.asyncIterator]()
    const first = "个人 iPhone"
    const second = "工作 iPhone"
    const firstToken = "11".repeat(32)
    const secondToken = "22".repeat(32)
    const invalid = "33".repeat(32)
    const temporary = "44".repeat(32)
    const delayedInvalid = "55".repeat(32)
    const observations = new Map<string, string>()

    async function call(method: string, params?: Record<string, unknown>) {
      return rpcSuccessSchema.parse(await host.call(method, params)).result
    }
    async function view() {
      return mobilePairingViewSchema.parse(await call("mobile.pairing"))
    }
    async function device(name: string) {
      return (await view()).devices.find((item) => item.name === name)
    }
    async function openPairing() {
      const attempt = mobilePairingViewSchema.parse(await call("mobile.pairing.start")).attempt
      if (!attempt?.qr) throw new Error("expected a pairing QR")
      return { id: attempt.id, qr: attempt.qr }
    }
    function command(phone: string, action: string, extras?: Record<string, unknown>) {
      dart.stdin.write(JSON.stringify({ phone, action, ...extras }) + "\n")
    }
    async function read() {
      const line = await lines.next()
      if (line.done) throw new Error(diagnostics || "Dart fixture exited early")
      return JSON.parse(line.value) as { stage: string; code?: string }
    }
    async function pair(phone: string) {
      const pairing = await openPairing()
      command(phone, "pair", { qr: pairing.qr, platform: "ios" })
      const proof = await read()
      const pending = (await view()).attempt?.candidate
      expect(proof.stage).toBe("code")
      expect(pending?.code).toBe(proof.code)
      await call("mobile.pairing.confirm", { id: pairing.id, confirmation: pending?.confirmation })
      expect(await read()).toEqual({ stage: "ready" })
      command(phone, "save")
      expect(await read()).toEqual({ stage: "saved" })
    }
    async function report(phone: string, enabled: boolean, environment?: string, token?: string) {
      const previous = (await device(phone))?.reminders?.syncedAt ?? 0
      let apns
      if (token) {
        const observationId = observations.get(token) ?? randomUUID()
        observations.set(token, observationId)
        apns = { token, environment, observationId }
      }
      command(phone, "reminderSettings", { enabled, apns })
      expect(await read()).toEqual({ stage: "reminders-reported" })
      await expect.poll(async () => (await device(phone))?.reminders?.syncedAt ?? 0).toBeGreaterThan(previous)
      expect((await device(phone))?.reminders?.enabled).toBe(enabled)
    }
    async function failRun(title: string) {
      const project = host.ctx.projects.add(profile, "APNs 验收")
      const thread = host.ctx.threads.create(project.id, title, "fake")
      const run = await host.ctx.agents.startRun(thread.id, FAKE_FAIL_TEXT)
      await run.done
      return { eventId: "result:" + run.runId, threadId: thread.id }
    }
    function deliveries(eventId: string) {
      return readFileSync(deliveriesPath!, "utf8").trim().split("\n").filter(Boolean)
        .map((line) => JSON.parse(line) as {
          notice: { eventId: string; threadId: string; kind: string }
          target: { deviceId: string; token: string; environment: string; registrationId: string }
        })
        .filter(({ notice }) => notice.eventId === eventId)
    }
    function recipients(eventId: string) {
      return deliveries(eventId)
        .map(({ target }) => [target.token, target.environment])
        .sort()
    }

    try {
      expect(await call("relay.testAndSave", { address, token: relayToken })).toMatchObject({ status: "saved" })
      await pair(first)
      await pair(second)
      await report(first, true, "sandbox", firstToken)
      await report(second, true, "production", secondToken)
      await expect.poll(async () => (await view()).devices.every((item) => item.pushRegistered)).toBe(true)
      expect(JSON.stringify(await view())).not.toContain(firstToken)
      const event = await failRun("两个环境")
      await expect.poll(() => recipients(event.eventId)).toEqual([
        [firstToken, "sandbox"], [secondToken, "production"],
      ])

      await report(first, true, "production", invalid)
      const rotated = await failRun("令牌更新")
      await expect.poll(() => recipients(rotated.eventId)).toEqual([
        [secondToken, "production"], [invalid, "production"],
      ])
      await expect.poll(async () => (await device(first))?.pushRegistered).toBeUndefined()
      expect((await device(second))?.pushRegistered).toBe(true)
      await report(first, true, "production", invalid)
      expect((await device(first))?.pushRegistered).toBeUndefined()

      const removed = await device(second)
      expect(await call("mobile.devices.revoke", { deviceId: removed?.id })).toMatchObject({ status: "revoked" })
      await report(first, true, "production", temporary)
      await expect.poll(async () => (await device(first))?.pushRegistered).toBe(true)
      await host.stop()
      host = await startMobileHost({ settingsPath })
      expect((await device(first))?.pushRegistered).toBe(true)
      const restored = await openPairing()
      await call("mobile.pairing.cancel", { id: restored.id })
      const afterRestart = await failRun("凭据恢复")
      await expect.poll(() => recipients(afterRestart.eventId)).toEqual([[temporary, "production"]])
      expect((await device(first))?.pushRegistered).toBe(true)

      command(first, "reconnect")
      expect(await read()).toEqual({ stage: "ready" })
      await report(first, true, "production", delayedInvalid)
      const older = await failRun("失效回执在途")
      await expect.poll(() => recipients(older.eventId)).toEqual([[delayedInvalid, "production"]])
      observations.delete(delayedInvalid)
      await report(first, true, "production", delayedInvalid)
      const renewed = await failRun("设备已重新登记")
      await expect.poll(() => recipients(renewed.eventId)).toEqual([[delayedInvalid, "production"]])
      expect(deliveries(renewed.eventId)[0]?.target.registrationId)
        .not.toBe(deliveries(older.eventId)[0]?.target.registrationId)
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect((await device(first))?.pushRegistered).toBe(true)
      await report(first, false)
      expect((await device(first))?.pushRegistered).toBeUndefined()
      await report(first, true)
      expect((await device(first))?.pushRegistered).toBeUndefined()
      const disabled = await failRun("重新开启，等待新令牌")
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(recipients(disabled.eventId)).toEqual([])
    } finally {
      dart.stdin.end()
      dart.kill()
      await host.stop()
      rmSync(profile, { recursive: true, force: true })
    }
  },
  30_000,
)
