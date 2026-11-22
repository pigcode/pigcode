import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { mobilePairingViewSchema, pairingCodeSchema, rpcSuccessSchema } from "@pigcode/contracts"
import { Context } from "cordis"
import { expect, it } from "vitest"
import { apply as agents } from "../agents/registry"
import { MobileConnections } from "../mobile/connections"
import { apply as projects } from "../services/projects"
import { RelaySettings } from "../services/relay-settings"
import { apply as sessions } from "../services/sessions"
import { apply as settings } from "../services/settings"
import { apply as storage } from "../services/storage"
import { apply as threads } from "../services/threads"
import { MemoryTransport } from "./memory-transport"
import { RpcServer } from "./server"

const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN

it.skipIf(!address || !token)(
  "pairs a Dart device through the Go relay only after the local desktop authorizes it",
  async () => {
    const ctx = new Context()
    await ctx.plugin(storage, { path: ":memory:" })
    await ctx.plugin(settings, {})
    await ctx.plugin(projects)
    await ctx.plugin(threads)
    await ctx.plugin(sessions)
    await ctx.plugin(agents)
    const cipher = {
      seal: async (value: string) => Buffer.from(value).toString("base64"),
      open: async (value: string) => Buffer.from(value, "base64").toString(),
    }
    const relay = new RelaySettings(ctx.settings, cipher)
    let now = Date.now()
    const mobile = new MobileConnections(ctx.settings, relay, cipher, () => now)
    ctx.provide("relaySettings", relay)
    ctx.provide("mobileConnections", mobile)

    const transport = new MemoryTransport({ skip: ["thread.changed"] })
    const server = new RpcServer(ctx, transport.host)
    server.start()
    async function call(method: string, params: Record<string, unknown> = {}) {
      const id = randomUUID()
      transport.client.send({ jsonrpc: "2.0", id, method, params })
      const response = rpcSuccessSchema.parse(await transport.client.next())
      expect(response.id).toBe(id)
      return response.result
    }

    let child: ReturnType<typeof spawn> | undefined
    try {
      expect(await call("relay.testAndSave", { address, token })).toMatchObject({ status: "saved" })
      const first = mobilePairingViewSchema.parse(await call("mobile.pairing.start"))
      expect(first).toMatchObject({ status: "waiting", devices: [] })
      expect(first.attempt?.expiresAt).toBeGreaterThan(Date.now())
      expect(await call("mobile.pairing.cancel", { id: first.attempt?.id })).toMatchObject({
        status: "cancelled",
        attempt: null,
      })
      await call("mobile.pairing.start")
      now += 180_001
      expect(await call("mobile.pairing")).toMatchObject({ status: "expired", attempt: null })
      now = Date.now()
      const started = mobilePairingViewSchema.parse(await call("mobile.pairing.start"))
      const qr = started.attempt?.qr
      if (!qr) throw new Error("desktop did not produce a pairing QR")
      expect(qr).not.toBe(first.attempt?.qr)
      const invite = pairingCodeSchema.parse(JSON.parse(qr))
      expect(invite.secret).not.toBe(pairingCodeSchema.parse(JSON.parse(first.attempt!.qr!)).secret)

      const dart = spawn("dart", ["run", "scripts/verify-pairing.dart"], {
        cwd: fileURLToPath(new URL("../../../mobile", import.meta.url)),
        env: { ...process.env, PIGCODE_TEST_PAIRING_QR: qr },
        stdio: ["ignore", "pipe", "pipe"],
      })
      child = dart
      let diagnostics = ""
      dart.stderr.setEncoding("utf8")
      dart.stderr.on("data", (chunk: string) => {
        diagnostics += chunk
      })
      let failure: Error | undefined
      const complete = new Promise<number | null>((resolve) => {
        dart.once("error", (error) => {
          failure = error
          resolve(null)
        })
        dart.once("close", resolve)
      })
      const lines = createInterface({ input: dart.stdout })
      const stages: string[] = []
      for await (const line of lines) {
        const progress = JSON.parse(line) as { stage: string; code?: string }
        stages.push(progress.stage)
        if (progress.stage === "blocked") {
          expect(await call("mobile.pairing")).toMatchObject({ devices: [] })
        }
        if (progress.stage === "code") {
          const view = mobilePairingViewSchema.parse(await call("mobile.pairing"))
          expect(view).toMatchObject({ status: "verify", devices: [] })
          expect(view.attempt?.candidate).toMatchObject({ code: progress.code, name: "验收手机" })
          expect(
            await call("mobile.pairing.confirm", {
              id: view.attempt?.id,
              confirmation: randomUUID(),
            }),
          ).toMatchObject({ status: "verify", devices: [] })
          expect(
            await call("mobile.pairing.confirm", {
              id: view.attempt?.id,
              confirmation: view.attempt?.candidate?.confirmation,
            }),
          ).toMatchObject({
            status: "paired",
            attempt: null,
            devices: [{ name: "验收手机", platform: "ios" }],
          })
        }
      }
      expect(await complete, failure?.message ?? diagnostics).toBe(0)
      expect(stages).toEqual(["blocked", "code", "verified"])
    } finally {
      child?.kill()
      server.stop()
      mobile.dispose()
      await ctx.fiber.dispose()
    }
  },
  30_000 + (Number(process.env.PIGCODE_RELAY_TEST_IDLE_SECONDS) || 0) * 1000,
)
