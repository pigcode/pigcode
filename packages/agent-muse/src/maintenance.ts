import { execFile } from "node:child_process"
import { readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { promisify } from "node:util"
import type { AgentCliUpdatePlan, AgentSettingsValues } from "@pigcode/plugin-sdk"
import { settingEnvironment, settingString } from "@pigcode/plugin-sdk"
import {
  agentEnvironment,
  expandHome,
  findExecutable,
  launchTarget,
  cliVersion,
  cliUpdateAvailable,
  runCliUpdate,
} from "@pigcode/plugin-sdk/node"

const exec = promisify(execFile)
const revision = /-R(\d+)(?:\.(\d+))?$/
export function parseMuseVersion(text: string) {
  return text.match(/\b\d+\.\d+\.\d+-R\d+(?:\.\d+)?\b/)?.[0] ?? cliVersion(text)
}
export function museUpdateAvailable(current: string | null, latest: string | null) {
  if (!current || !latest) return false
  const numbered = revision.test(current) && revision.test(latest)
  const convert = (s: string) =>
    s.replace(revision, (_all, release: string, patch: string | undefined) =>
      numbered ? "-release." + release + "." + (patch ?? "0") : "",
    )
  return cliUpdateAvailable(convert(current), convert(latest))
}

export function museCommand(settings: AgentSettingsValues) {
  const env = agentEnvironment(settingEnvironment(settings), { MUSE_NO_AUTO_UPDATE: "1" })
  const path = expandHome(
    settingString(settings, "binaryPath") ?? "muse",
    env.HOME || env.USERPROFILE || homedir(),
  )
  const executable =
    isAbsolute(path) || /[\\/]/.test(path)
      ? resolve(path)
      : (findExecutable(path, undefined, env.PATH) ?? path)
  const target = launchTarget(executable)
  if (target.shell) throw new Error("Select the native Muse executable")
  return { ...target, executable, env }
}
export async function museVersion(cli: ReturnType<typeof museCommand>) {
  const { stdout } = await exec(cli.command, [...cli.args, "--version"], {
    env: cli.env,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  })
  return parseMuseVersion(stdout)
}
async function launcher(path: string) {
  if (process.platform === "win32") return false
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > 128 * 1024) return false
    const script = await readFile(path, "utf8")
    return script.includes("muse-code/launcher-") && script.includes("MUSE_SYNC_UPDATE")
  } catch {
    return false
  }
}
async function latest(channel: string) {
  try {
    const response = await fetch("https://api.meta.ai/muse-code/channels/" + channel, {
      signal: AbortSignal.timeout(4_000),
    })
    if (!response.ok) return null
    const manifest: unknown = await response.json()
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("version" in manifest) ||
      typeof manifest.version !== "string"
    )
      return null
    return /^\d+\.\d+\.\d+-R\d+(?:\.\d+)?$/.test(manifest.version) ? manifest.version : null
  } catch {
    return null
  }
}
export async function prepareMuseUpdate(
  settings: AgentSettingsValues,
): Promise<AgentCliUpdatePlan> {
  const cli = museCommand(settings)
  const verify = () => museVersion(cli).catch(() => null)
  const currentVersion = await verify()
  const base: AgentCliUpdatePlan = {
    target: cli.executable,
    currentVersion,
    latestVersion: null,
    available: false,
    command: null,
    reason: currentVersion ? "unknown-installation" : "not-installed",
    verify,
    isUpdateAvailable: museUpdateAvailable,
  }
  const channel = cli.env.MUSE_CHANNEL || "muse-stable"
  if (!currentVersion || !["muse-stable", "muse-canary"].includes(channel)) return base
  const latestVersion = await latest(channel)
  const plan = {
    ...base,
    latestVersion,
    available: museUpdateAvailable(currentVersion, latestVersion),
  }
  const target = await realpath(cli.executable).catch(() => null)
  if (!target || !(await launcher(target))) return plan
  const overrides = {
    MUSE_CHANNEL: channel,
    MUSE_NO_AUTO_UPDATE: "0",
    MUSE_SYNC_UPDATE: "1",
    MUSE_UPDATE_INTERVAL_SECONDS: "0",
  }
  const command =
    Object.entries(overrides)
      .map(([name, value]) => name + "=" + value)
      .join(" ") +
    " " +
    JSON.stringify(cli.executable) +
    " --version"
  return {
    ...plan,
    target: "muse:" + target,
    command,
    reason: null,
    run: (runtime) =>
      runCliUpdate(cli.executable, ["--version"], { ...cli.env, ...overrides }, runtime),
  }
}
