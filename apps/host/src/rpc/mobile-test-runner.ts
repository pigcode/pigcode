import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ownProcessTree, PROCESS_TREE_SPAWN_OPTIONS } from "@pigcode/plugin-sdk/node"

export const mobileDirectory = fileURLToPath(new URL("../../../mobile", import.meta.url))
const desktopPackage = new URL("../../../desktop/package.json", import.meta.url)

export async function runFlutter(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
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

export async function prepareMobileTestRunner(
  directory: string,
  platform: "ios" | "android",
  options: { prefix: string; entrypoint: URL; testName: string; projectName?: string },
  signal: AbortSignal,
) {
  const runner = join(directory, "runner")
  const projectName = options.projectName ?? options.prefix + randomBytes(4).toString("hex")
  const version = JSON.parse(readFileSync(desktopPackage, "utf8")).version as string
  const buildNumber = process.env.PIGCODE_MOBILE_BUILD_NUMBER ?? "1"
  if (!/^[1-9]\d*$/.test(buildNumber)) throw new Error("PIGCODE_MOBILE_BUILD_NUMBER 必须为正整数。")
  await runFlutter([
    "create", "--no-pub", `--platforms=${platform}`, "--org", "com.pigcode",
    "--project-name", projectName, runner,
  ], directory, signal)
  writeFileSync(join(runner, "pubspec.yaml"), JSON.stringify({
    name: projectName,
    publish_to: "none",
    version: `${version.split(/[-+]/)[0]}+${buildNumber}`,
    environment: { sdk: ">=3.12.2 <4.0.0" },
    dependencies: {
      flutter: { sdk: "flutter" },
      flutter_riverpod: "any",
      flutter_secure_storage: "any",
      pigcode_client: "any",
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
  const entrypoint = "integration_test/" + options.testName
  copyFileSync(options.entrypoint, join(runner, entrypoint))
  await runFlutter(["pub", "get"], runner, signal)
  return { runner, entrypoint, version, buildNumber }
}
