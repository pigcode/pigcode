/** Agent 插件可复用的包管理器更新实现。插件提供包名、执行文件和原生更新策略。 */
import { execFile } from "node:child_process"
import { readFile, realpath } from "node:fs/promises"
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"
import semver from "semver"
import type { AgentCliUpdatePlan } from "./agent"
import { findExecutable, launchTarget, shimTarget } from "./node"
import {
  resolveCliUpdateSource,
  type CliUpdateSource,
  type NativeCliUpdate,
} from "./cli-update-source"
import { runCliUpdate } from "./cli-update-process"

const exec = promisify(execFile)
const versions = new Map<string, { at: number; result: Promise<string | null> }>()

/** 从 CLI 的版本输出中提取完整 semver，保留预发布标识。 */
export function cliVersion(text: string): string | null {
  const candidate = text.match(/\bv?(\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?)/i)?.[1]
  return candidate ? semver.valid(candidate) : null
}

export function cliUpdateAvailable(current: string | null, latest: string | null): boolean {
  return Boolean(
    current &&
    latest &&
    semver.valid(current) &&
    semver.valid(latest) &&
    semver.lt(current, latest),
  )
}

async function latestVersion(source: CliUpdateSource): Promise<string | null> {
  const cached = versions.get(source.versionUrl)
  if (cached && Date.now() - cached.at < 60_000) return cached.result
  const result = (async () => {
    try {
      const response = await fetch(source.versionUrl, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) return null
      if (source.versionFormat === "text") return cliVersion(await response.text())
      const value = (await response.json()) as { version?: string; versions?: { stable?: string } }
      return cliVersion(
        source.versionFormat === "brew-formula"
          ? (value.versions?.stable ?? "")
          : (value.version ?? ""),
      )
    } catch {
      return null
    }
  })()
  versions.set(source.versionUrl, { at: Date.now(), result })
  return result
}

/** pnpm 在 Unix 下可能使用 shell shim，通过包管理器核对它的实际全局安装位置。 */
async function pnpmShimSource(
  executable: string,
  packageName: string,
  env: NodeJS.ProcessEnv,
): Promise<CliUpdateSource | null> {
  const directory = dirname(executable)
  if (!/pnpm/i.test(directory)) return null
  const manager = findExecutable("pnpm", [directory], env.PATH)
  if (!manager) return null
  const read = async (command: "root" | "bin") => {
    const target = launchTarget(manager, [command, "--global"])
    const { stdout } = await exec(target.command, target.args, {
      env,
      shell: target.shell,
      timeout: 5_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
    return stdout.trim()
  }
  try {
    const [root, bin] = await Promise.all([read("root"), read("bin")])
    if (resolve(bin) !== resolve(directory)) return null
    const manifest = JSON.parse(
      await readFile(join(root, packageName, "package.json"), "utf8"),
    ) as { name?: string }
    if (manifest.name !== packageName) return null
    return {
      manager: "pnpm",
      directory,
      args: [
        "add",
        "--global",
        "--global-dir",
        dirname(root),
        "--global-bin-dir",
        bin,
        `${packageName}@latest`,
      ],
      versionUrl: `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
      versionFormat: "npm",
    }
  } catch {
    return null
  }
}

export async function preparePackageCliUpdate(input: {
  packageName: string
  executable: string
  env?: NodeJS.ProcessEnv | undefined
  brewFormula?: string | undefined
  native?: NativeCliUpdate | undefined
  /** 仅升级当前大版本。包管理器和自更新命令都必须能指定确切的目标版本。 */
  pinMajor?: number
}): Promise<AgentCliUpdatePlan> {
  const env = { ...process.env, ...input.env }
  const executable = isAbsolute(input.executable)
    ? input.executable
    : (findExecutable(input.executable, undefined, env.PATH) ?? input.executable)
  const probe = async () => {
    const target = launchTarget(executable, ["--version"])
    try {
      const { stdout } = await exec(target.command, target.args, {
        env,
        shell: target.shell,
        timeout: 8_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      })
      return cliVersion(stdout)
    } catch {
      return null
    }
  }
  const currentVersion = await probe()
  const base: AgentCliUpdatePlan = {
    target: executable,
    currentVersion,
    latestVersion: null,
    available: false,
    command: null,
    reason: currentVersion ? "unknown-installation" : "not-installed",
    verify: probe,
  }
  if (!currentVersion) return base
  const realExecutable = await realpath(shimTarget(executable) ?? executable).catch(
    () => executable,
  )
  const bin = await realpath(dirname(executable)).catch(() => dirname(executable))
  const resolved = { ...input, executable: join(bin, basename(executable)), realExecutable }
  const source =
    resolveCliUpdateSource({ ...resolved, native: undefined }) ??
    (await pnpmShimSource(executable, input.packageName, env)) ??
    resolveCliUpdateSource(resolved)
  if (!source) return base
  const latest = await latestVersion(source)
  let args = source.args
  if (input.pinMajor !== undefined) {
    if (
      !latest ||
      semver.major(currentVersion) !== input.pinMajor ||
      semver.major(latest) !== input.pinMajor
    )
      return base
    if (!args.includes(input.packageName + "@latest") && !args.includes("{version}")) return base
    args = args.map((arg) =>
      arg === "{version}"
        ? latest
        : arg === input.packageName + "@latest"
          ? input.packageName + "@" + latest
          : arg,
    )
  }
  const command =
    source.manager === "native"
      ? executable
      : findExecutable(
          source.manager,
          [],
          [source.directory, env.PATH].filter(Boolean).join(delimiter),
        )
  const info = {
    ...base,
    latestVersion: latest,
    available: cliUpdateAvailable(currentVersion, latest),
  }
  if (!command) return { ...info, reason: "manager-unavailable" }
  const updateEnv: NodeJS.ProcessEnv = {
    ...env,
    ...(source.manager === "native" ? input.native?.env : undefined),
    PATH: [source.directory, env.PATH].filter(Boolean).join(delimiter),
  }
  if (source.manager === "bun") updateEnv.BUN_INSTALL = dirname(source.directory)
  if (source.manager === "brew") updateEnv.HOMEBREW_NO_AUTO_UPDATE = "1"
  return {
    ...info,
    target: `${source.manager}:${source.directory}:${input.packageName}`,
    command: [command, ...args]
      .map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))
      .join(" "),
    reason: null,
    run: (runtime) => runCliUpdate(command, args, updateEnv, runtime),
  }
}
