import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mobilePairingViewSchema, pairingCodeSchema, rpcSuccessSchema } from "@pigcode/contracts"
import { expect, it } from "vitest"
import { noiseKeyPair } from "../mobile/noise"
import { mobileTestCipher, startMobileHost } from "./mobile-test-fixture"
import { mobileDirectory, prepareMobileTestRunner, runFlutter } from "./mobile-test-runner"

const device = process.env.PIGCODE_SIMULATOR_SMOKE_DEVICE
const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN
const ca = process.env.PIGCODE_RELAY_TEST_CA
const agent = process.env.PIGCODE_SIMULATOR_SMOKE_AGENT ?? "fake"
const fixtureTest = new URL("../../../../scripts/fixtures/mobile_paired_reply.dart", import.meta.url)

it.skipIf(!device)(
  "installs the mobile app on the simulator and receives a reply through Go WSS",
  async () => {
    if (!address || !token || !ca || new URL(address).hostname !== "127.0.0.1") {
      throw new Error("The simulator smoke test requires the local WSS fixture and its CA.")
    }
    if (agent !== "fake" &&
        !(agent === "claude" && process.env.PIGCODE_REAL_CLAUDE === "1") &&
        !(agent === "codex" && process.env.PIGCODE_REAL_CODEX === "1")) {
      throw new Error("Enable the matching real Agent flag before using a real Agent in this test.")
    }
    const signal = AbortSignal.timeout(300_000)
    const listed = await runFlutter(["devices", "--machine"], mobileDirectory, signal)
    const devices = JSON.parse(listed) as Array<{ id: string; emulator: boolean; targetPlatform: string }>
    const target = devices.find((item) => item.id === device)
    if (!target?.emulator || !(target.targetPlatform === "ios" || target.targetPlatform.startsWith("android-"))) {
      throw new Error("Choose the exact ID of a running iOS Simulator or Android emulator.")
    }
    const platform = target.targetPlatform === "ios" ? "ios" : "android"
    const directory = mkdtempSync(join(tmpdir(), "pigcode-simulator-host-"))
    const settingsPath = join(directory, "settings.json")
    const computer = noiseKeyPair()
    const phone = noiseKeyPair()
    let host: Awaited<ReturnType<typeof startMobileHost>> | undefined
    let closeDriver: (() => Promise<void>) | undefined
    try {
      const { runner, entrypoint, version } = await prepareMobileTestRunner(directory, platform, {
        prefix: "pigcodesmoke",
        entrypoint: fixtureTest,
        testName: "paired_reply_test.dart",
      }, signal)
      writeFileSync(settingsPath, JSON.stringify({
        "mobile.identity": await mobileTestCipher.seal(computer.seed.toString("base64url")),
        "mobile.devices": [{
          publicKey: phone.publicKey.toString("base64url"),
          name: "模拟器验收手机",
          platform,
          lastConnectedAt: null,
        }],
      }), { mode: 0o600 })
      host = await startMobileHost({ settingsPath })
      const current = host
      async function call(method: string, params?: Record<string, unknown>) {
        return rpcSuccessSchema.parse(await current.call(method, params)).result
      }
      if (agent === "claude") {
        const { ClaudeDriver } = await import("@pigcode/agent-claude/driver")
        const driver = new ClaudeDriver()
        host.ctx.agents.register(driver)
        closeDriver = () => driver.close()
      } else if (agent === "codex") {
        const { CodexDriver } = await import("@pigcode/agent-codex/driver")
        const driver = new CodexDriver()
        host.ctx.agents.register(driver)
        closeDriver = () => driver.close()
      }
      expect(await call("relay.testAndSave", { address, token })).toMatchObject({ status: "saved" })
      const pairing = mobilePairingViewSchema.parse(await call("mobile.pairing.start"))
      if (!pairing.attempt?.qr) throw new Error("Host did not connect to the test relay.")
      const invite = pairingCodeSchema.parse(JSON.parse(pairing.attempt.qr))
      await call("mobile.pairing.cancel", { id: pairing.attempt.id })

      const project = host.ctx.projects.add(directory, "模拟器验收项目")
      const title = "从安装到回复"
      const thread = host.ctx.threads.create(project.id, title, agent, undefined, {
        permissionMode: "read-only",
        modelId: agent === "claude" ? process.env.PIGCODE_CLAUDE_MODEL : process.env.PIGCODE_CODEX_MODEL,
      })
      const prompt = "Reply with exactly OK"
      const reply = agent === "fake" ? "Hello from fake agent" : "OK"
      const fixture = {
        computer: {
          address: invite.address,
          token: invite.token,
          computerKey: invite.computerKey,
          computerName: "模拟器验收电脑",
        },
        phoneSeed: phone.seed.toString("base64url"),
        ca: readFileSync(ca).toString("base64"),
        title, prompt, reply,
      }
      const defines = join(directory, "defines.json")
      writeFileSync(defines, JSON.stringify({
        PIGCODE_PRODUCT_VERSION: version,
        PIGCODE_SIMULATOR_SMOKE: Buffer.from(JSON.stringify(fixture)).toString("base64url"),
      }), { mode: 0o600 })
      const eventTypes = () => current.ctx.sessions.read(thread.id, 0).map((event) => event.type)
      try {
        const stdout = await runFlutter([
          "test", "--no-pub", "-d", target.id, "--reporter", "expanded",
          "--dart-define-from-file", defines, entrypoint,
        ], runner, signal)
        console.info(stdout.trim())
        await expect.poll(eventTypes).toContain("run.completed")
      } catch (error) {
        console.info("Host events from the simulator smoke:", eventTypes())
        if (signal.aborted) {
          // Flutter may have been killed before it could uninstall its temporary Runner.
          try {
            await runFlutter(["install", "--uninstall-only", "--debug", "-d", target.id], runner, AbortSignal.timeout(15_000))
          } catch (cleanupError) {
            console.warn("Could not uninstall the temporary simulator Runner:", cleanupError)
          }
        }
        throw error
      }
    } finally {
      try {
        await host?.stop()
      } finally {
        try {
          await closeDriver?.()
        } finally {
          rmSync(directory, { recursive: true, force: true })
        }
      }
    }
  },
  330_000,
)
