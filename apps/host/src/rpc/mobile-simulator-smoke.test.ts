import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { mobilePairingViewSchema, pairingCodeSchema, rpcSuccessSchema } from "@pigcode/contracts"
import { ownProcessTree, PROCESS_TREE_SPAWN_OPTIONS } from "@pigcode/plugin-sdk/node"
import { expect, it } from "vitest"
import { noiseKeyPair } from "../mobile/noise"
import { mobileTestCipher, startMobileHost } from "./mobile-test-fixture"

const device = process.env.PIGCODE_SIMULATOR_SMOKE_DEVICE
const address = process.env.PIGCODE_RELAY_TEST_URL
const token = process.env.PIGCODE_RELAY_TEST_TOKEN
const ca = process.env.PIGCODE_RELAY_TEST_CA
const agent = process.env.PIGCODE_SIMULATOR_SMOKE_AGENT ?? "fake"
const mobileDirectory = fileURLToPath(new URL("../../../mobile", import.meta.url))
const desktopPackage = new URL("../../../desktop/package.json", import.meta.url)
const fixtureTest = new URL("../../../../scripts/fixtures/mobile_paired_reply.dart", import.meta.url)

async function flutter(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const child = spawn("flutter", args, {
    ...PROCESS_TREE_SPAWN_OPTIONS,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const tree = ownProcessTree(child)
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-32_000) })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_000) })
  let stopping: Promise<void> | undefined
  const abort = () => { stopping ??= tree.terminate({ graceMs: 250 }) }
  signal.addEventListener("abort", abort, { once: true })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve)
      child.once("error", reject)
      if (signal.aborted) abort()
    })
    signal.throwIfAborted()
    if (code !== 0) throw new Error(`flutter ${args[0]} failed\n${stdout}\n${stderr}`)
    return stdout
  } finally {
    signal.removeEventListener("abort", abort)
    await stopping
  }
}

async function prepareRunner(
  directory: string,
  platform: "ios" | "android",
  version: string,
  signal: AbortSignal,
) {
  const runner = join(directory, "runner")
  const projectName = "pigcodesmoke" + randomBytes(4).toString("hex")
  await flutter([
    "create", "--no-pub", `--platforms=${platform}`, "--org", "com.pigcode",
    "--project-name", projectName, runner,
  ], directory, signal)
  const buildNumber = process.env.PIGCODE_MOBILE_BUILD_NUMBER ?? "1"
  if (!/^[1-9]\d*$/.test(buildNumber)) throw new Error("Choose a positive smoke build number.")
  writeFileSync(join(runner, "pubspec.yaml"), JSON.stringify({
    name: projectName,
    publish_to: "none",
    version: `${version.split(/[-+]/)[0]}+${buildNumber}`,
    environment: { sdk: ">=3.12.2 <4.0.0" },
    dependencies: {
      flutter: { sdk: "flutter" },
      flutter_riverpod: "any",
      flutter_secure_storage: "any",
      pigcode_mobile: { path: join(mobileDirectory, "app") },
      pigcode_transport: "any",
    },
    dependency_overrides: {
      pigcode_client: { path: join(mobileDirectory, "packages/pigcode_client") },
      pigcode_transport: { path: join(mobileDirectory, "packages/pigcode_transport") },
    },
    dev_dependencies: {
      flutter_test: { sdk: "flutter" },
      integration_test: { sdk: "flutter" },
    },
    flutter: { "uses-material-design": true },
  }, null, 2) + "\n")
  copyFileSync(join(mobileDirectory, "pubspec.lock"), join(runner, "pubspec.lock"))
  mkdirSync(join(runner, "integration_test"))
  copyFileSync(fixtureTest, join(runner, "integration_test/paired_reply_test.dart"))
  await flutter(["pub", "get"], runner, signal)
  return runner
}

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
    const listed = await flutter(["devices", "--machine"], mobileDirectory, signal)
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
      const version = JSON.parse(readFileSync(desktopPackage, "utf8")).version as string
      const runner = await prepareRunner(directory, platform, version, signal)
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
        const stdout = await flutter([
          "test", "--no-pub", "-d", target.id, "--reporter", "expanded",
          "--dart-define-from-file", defines, "integration_test/paired_reply_test.dart",
        ], runner, signal)
        console.info(stdout.trim())
        await expect.poll(eventTypes).toContain("run.completed")
      } catch (error) {
        console.info("Host events from the simulator smoke:", eventTypes())
        if (signal.aborted) {
          // Flutter may have been killed before it could uninstall its temporary Runner.
          try {
            await flutter(["install", "--uninstall-only", "-d", target.id], runner, AbortSignal.timeout(15_000))
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
