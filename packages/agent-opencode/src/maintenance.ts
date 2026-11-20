import { realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join, normalize } from "node:path"
import type { AgentCliUpdatePlan, AgentSettingsValues } from "@pigcode/plugin-sdk"
import { settingString } from "@pigcode/plugin-sdk"
import { preparePackageCliUpdate } from "@pigcode/plugin-sdk/node"
import { openCodeCli } from "./server"

function localServer(address: string) {
  const url = URL.parse(address)
  return (
    !!url &&
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" ||
      url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(url.hostname))
  )
}

/** curl's own installer replaces the executable under this account's .opencode/bin. */
export function nativeOpenCode(path: string, home: string) {
  const target = normalize(path)
  const expected = normalize(join(home, ".opencode", "bin", "opencode"))
  return process.platform === "win32"
    ? [expected, expected + ".exe"].some((p) => p.toLowerCase() === target.toLowerCase())
    : target === expected
}

export async function prepareOpenCodeUpdate(
  settings: AgentSettingsValues,
  localVersion: () => Promise<string | null>,
  onUpdated: () => Promise<void>,
): Promise<AgentCliUpdatePlan> {
  const address = settingString(settings, "serverUrl")
  const remote = Boolean(address && !localServer(address))
  const probe = remote ? async () => null : localVersion
  const currentVersion = await probe()
  const base: AgentCliUpdatePlan = {
    target: remote ? "opencode:external" : (settingString(settings, "binaryPath") ?? "opencode"),
    currentVersion,
    latestVersion: null,
    available: false,
    command: null,
    reason: remote ? "unsupported" : currentVersion ? "unknown-installation" : "not-installed",
    verify: probe,
  }
  const major = currentVersion?.startsWith("2.") ? 2 : currentVersion?.startsWith("1.") ? 1 : null
  if (!major) return base
  const cli = openCodeCli(settings)
  const packageName = major === 2 ? "@opencode/cli" : "opencode-ai"
  const installHome = cli.env.HOME || cli.env.USERPROFILE || homedir()
  const home = await realpath(installHome).catch(() => installHome)
  const plan = await preparePackageCliUpdate({
    executable: cli.executable,
    env: cli.env,
    packageName,
    pinMajor: major,
    native: {
      matches: (path) => nativeOpenCode(path, home),
      args: ["upgrade", "{version}", "--method", "curl"],
      versionFormat: "npm",
      versionUrl: "https://registry.npmjs.org/" + encodeURIComponent(packageName) + "/latest",
    },
  })
  const run = plan.run
  if (!run || address) return plan
  return {
    ...plan,
    run: async (runtime) => {
      await run(runtime)
      await onUpdated()
    },
  }
}
