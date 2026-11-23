import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import { mobileDirectory, prepareMobileTestRunner, runFlutter } from "./mobile-test-runner"

const device = process.env.PIGCODE_TIMELINE_PROFILE_DEVICE
const fixture = new URL("../../../../scripts/fixtures/mobile_timeline_profile.dart", import.meta.url)
const driver = new URL("../../../../scripts/fixtures/mobile_timeline_profile_driver.dart", import.meta.url)

it.skipIf(!device)(
  "replays a long mobile timeline and records frame and memory measurements",
  async () => {
    const signal = AbortSignal.timeout(540_000)
    const git = (args: string[]) => execFileSync("git", args, { cwd: mobileDirectory, encoding: "utf8" }).trim()
    const frontendCommit = git(["rev-parse", "HEAD"])
    const workingTreeDirty = git(["status", "--porcelain"]).length > 0
    const sdk = JSON.parse(await runFlutter(["--version", "--machine"], mobileDirectory, signal)) as { frameworkVersion: string }
    const required = readFileSync(join(mobileDirectory, ".flutter-version"), "utf8").trim()
    if (sdk.frameworkVersion !== required) {
      throw new Error(`需要 Flutter ${required}，当前为 ${sdk.frameworkVersion}。`)
    }
    const listed = await runFlutter(["devices", "--machine"], mobileDirectory, signal)
    const devices = JSON.parse(listed) as Array<{
      id: string; name: string; sdk: string; emulator: boolean; targetPlatform: string
    }>
    const target = devices.find((item) => item.id === device)
    if (!target || !(target.targetPlatform === "ios" || target.targetPlatform.startsWith("android-"))) {
      throw new Error("请选择 flutter devices 列出的一台手机或模拟器的完整 ID。")
    }
    const platform = target.targetPlatform === "ios" ? "ios" : "android"
    const mode = target.emulator ? "debug" : "profile"
    const directory = mkdtempSync(join(tmpdir(), "pigcode-timeline-profile-"))
    const report = resolve(process.env.PIGCODE_TIMELINE_PROFILE_REPORT ?? `${directory}.json`)
    let preparedRunner: string | undefined
    try {
      if (existsSync(report)) throw new Error(`请选择新的报告路径，文件已存在 ${report}`)
      const { runner, entrypoint, version, buildNumber } = await prepareMobileTestRunner(directory, platform, {
        prefix: "pigcodetimeline",
        entrypoint: fixture,
        testName: "timeline_profile_test.dart",
        ...(target.emulator ? {} : { projectName: "pigcodetimelineprofile" }),
      }, signal)
      const driverPath = "test_driver/timeline_profile_driver.dart"
      mkdirSync(join(runner, "test_driver"))
      copyFileSync(driver, join(runner, driverPath))
      preparedRunner = runner
      console.info(`在 ${platform} ${mode} 模式运行长会话回放。`)
      const stdout = await runFlutter([
        "drive", "--no-pub", `--${mode}`, "-d", target.id,
        "--driver", driverPath, "--target", entrypoint,
      ], runner, signal)
      console.info(stdout.trim())

      const result = JSON.parse(readFileSync(join(runner, "build/timeline-profile.json"), "utf8"))
      expect(result).toMatchObject({ mode, anchorsPreserved: true, followedLatest: true })
      writeFileSync(report, JSON.stringify({
        frontendCommit,
        workingTreeDirty,
        productVersion: version,
        buildNumber,
        flutterVersion: sdk.frameworkVersion,
        device: { name: target.name, sdk: target.sdk, simulator: target.emulator },
        ...result,
      }, null, 2) + "\n", { flag: "wx", mode: 0o600 })
      console.info(`长会话回放报告 ${report}`)
    } finally {
      try {
        if (preparedRunner) {
          await runFlutter([
            "install", "--uninstall-only", `--${mode}`, "-d", target.id,
          ], preparedRunner, AbortSignal.timeout(25_000))
        }
      } catch (error) {
        console.warn("临时回放程序未能自动卸载。", error)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  },
  580_000,
)
