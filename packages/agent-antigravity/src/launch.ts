import { authConfig } from "./auth-config"
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"
import {
  settingEnvironment,
  settingString,
  type AgentInstanceContext,
  type AgentSettingsValues,
} from "@pigcode/plugin-sdk"
import {
  agentEnvironment,
  expandHome,
  findExecutable,
  launchTarget,
  PROCESS_TREE_SPAWN_OPTIONS,
} from "@pigcode/plugin-sdk/node"

const ACP_DATA_DIR = "antigravity-acp"
const PROFILE_ID = "active-profile"
const exec = promisify(execFile)
const RESERVED_ENV = new Set([
  "GEMINI_HOME",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ADC_AUTH",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "ANTIGRAVITY_HARNESS_PATH",
])

export interface AgyProfile {
  directory: string
  tokenPath: string
}

function profilePath(instance: AgentInstanceContext, id: string): AgyProfile {
  const directory = join(instance.dataDir, id)
  return { directory, tokenPath: join(directory, ACP_DATA_DIR, "acp_token.json") }
}

export function newProfile(instance: AgentInstanceContext): AgyProfile {
  return profilePath(instance, randomUUID())
}

function pointer(instance: AgentInstanceContext, settings: AgentSettingsValues) {
  const key = authConfig(settings).profileKey
  return join(instance.dataDir, key ? PROFILE_ID + "-" + key : PROFILE_ID)
}
export async function instanceProfile(
  instance: AgentInstanceContext,
  settings: AgentSettingsValues = {},
): Promise<AgyProfile> {
  const id = await readFile(pointer(instance, settings), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "initial"
      throw error
    },
  )
  if (!/^(?:initial|[a-f0-9-]{36})$/.test(id)) throw new Error("Invalid Antigravity instance data")
  const key = authConfig(settings).profileKey
  return profilePath(instance, id === "initial" && key ? "initial-" + key : id)
}

/** 只在完成 ACP 验证后切换目录。 */
export async function activateProfile(
  instance: AgentInstanceContext,
  profile: AgyProfile,
  signal: AbortSignal,
  settings: AgentSettingsValues = {},
): Promise<void> {
  const id = basename(profile.directory)
  const temporary = join(instance.dataDir, `.${id}`)
  try {
    await writeFile(temporary, id, { flag: "wx", mode: 0o600, signal })
    signal.throwIfAborted()
    await rename(temporary, pointer(instance, settings))
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function hasCredential(profile: AgyProfile): Promise<boolean> {
  return access(profile.tokenPath).then(
    () => true,
    () => false,
  )
}

export function configuredBinary(settings: AgentSettingsValues): string | undefined {
  const configured = settingString(settings, "binaryPath")
  if (!configured) return undefined
  const path = expandHome(configured)
  if (isAbsolute(path) || /[/\\]/.test(path)) return resolve(path)
  return (
    findExecutable(path, undefined, agentEnvironment(settingEnvironment(settings)).PATH) ?? path
  )
}

export function pathBinary(settings: AgentSettingsValues): string | undefined {
  return findExecutable("agy", undefined, agentEnvironment(settingEnvironment(settings)).PATH)
}

/** 官方独立 ACP 发行包由入口和同目录 harness 组成。 */
export async function standaloneHarness(command: string): Promise<string | undefined> {
  const windows = process.platform === "win32"
  if (basename(command).toLowerCase() !== (windows ? "agy_acp_server.exe" : "agy_acp_server.par"))
    return undefined
  const harness = join(
    dirname(command),
    windows ? "localharness_external.exe" : "localharness_external",
  )
  if (!(await stat(harness).catch(() => undefined))?.isFile())
    throw new Error(
      "The standalone Antigravity ACP executable needs its matching localharness_external file",
    )
  return harness
}

function cliEnvironment(settings: AgentSettingsValues): NodeJS.ProcessEnv {
  return agentEnvironment(settingEnvironment(settings), { AGY_CLI_DISABLE_AUTO_UPDATE: "1" })
}

/** agy models 可以验证 CLI 已有账号，无需发起登录或创建原生会话。 */
export async function hasCliLogin(
  command: string,
  settings: AgentSettingsValues,
): Promise<boolean> {
  const target = launchTarget(command, ["models"])
  if (target.shell) return false
  try {
    const { stdout } = await exec(target.command, target.args, {
      env: cliEnvironment(settings),
      timeout: 8_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    })
    return stdout.split(/\r?\n/).some((line) => /^\S+\t\S/.test(line.trim()))
  } catch {
    return false
  }
}

export interface AgyLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  authenticateMethod?: string
  legacyProtocolVersion?: 2
}

export async function acpLaunch(
  command: string,
  settings: AgentSettingsValues,
  profile: AgyProfile | null,
  cwd: string,
): Promise<AgyLaunch> {
  const env = cliEnvironment(settings)
  const auth = authConfig(settings)
  if (auth.error) throw new Error(auth.error)
  // 沿用 CLI 的登录时也沿用它的原生存储位置，让钥匙串和文件凭据都由 agy 自己解析。
  if (!profile) return { command, cwd, args: ["acp"], env }
  const harness = await standaloneHarness(command)
  const usesAdc = auth.method === "agent-platform" && !auth.key
  if (auth.method === "agent-platform" && auth.key && !harness)
    throw new Error(
      "This agy ACP runtime uses Application Default Credentials for Vertex AI. Clear the API key and set a GCP project and location, or select an official standalone ACP runtime that supports the key.",
    )
  const adcPath = usesAdc
    ? Object.entries(env).find(
        ([key]) => key.toUpperCase() === "GOOGLE_APPLICATION_CREDENTIALS",
      )?.[1]
    : undefined
  const data = join(profile.directory, ACP_DATA_DIR)
  await mkdir(data, { recursive: true, mode: 0o700 })
  // 原生 logout 读取这个字段来清理本次采用的登录方式。
  await writeFile(
    join(data, "settings.json"),
    JSON.stringify({
      auth: { type: auth.method },
      ...(Object.keys(auth.gcp).length ? { gcp: auth.gcp } : {}),
    }),
    {
      flag: "wx",
      mode: 0o600,
    },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  for (const key of Object.keys(env)) {
    if (
      RESERVED_ENV.has(key.toUpperCase()) ||
      /^AGY_ACP_FORCE_FILE_STORAGE$|^AGY_CLI_DISABLE_AUTO_UPDATE$/i.test(key)
    )
      delete env[key]
  }
  return {
    command,
    cwd,
    args: harness
      ? process.platform === "linux"
        ? ["--uid="]
        : []
      : ["acp", "--gemini-dir", profile.directory, "--app-data-dir", ACP_DATA_DIR],
    ...(harness ? { legacyProtocolVersion: 2 } : {}),
    ...(!auth.browser ? { authenticateMethod: auth.method } : {}),
    env: {
      ...env,
      // agy 1.5 的本地图形模式使用全局钥匙串；SSH 模式会按目录保存账号。
      ...(harness
        ? { ANTIGRAVITY_HARNESS_PATH: harness }
        : {
            SSH_CONNECTION: env.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0",
          }),
      ...(auth.method === "gemini-api-key" && auth.key ? { GEMINI_API_KEY: auth.key } : {}),
      ...(auth.method === "agent-platform" && auth.key ? { GOOGLE_API_KEY: auth.key } : {}),
      ...(usesAdc
        ? {
            ...(adcPath ? { GOOGLE_APPLICATION_CREDENTIALS: adcPath } : {}),
            AGY_ADC_AUTH: "true",
            GOOGLE_CLOUD_PROJECT: auth.gcp.project,
            GOOGLE_CLOUD_LOCATION: auth.gcp.location,
          }
        : {}),
      GEMINI_HOME: profile.directory,
      AGY_ACP_FORCE_FILE_STORAGE: "1",
      AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    },
  }
}

export function spawnAgy(launch: AgyLaunch, args: string[] = []): ChildProcessWithoutNullStreams {
  const target = launchTarget(launch.command, [...launch.args, ...args])
  if (target.shell) throw new Error("Select the Antigravity executable or a supported CLI launcher")
  const child = spawn(target.command, target.args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    ...PROCESS_TREE_SPAWN_OPTIONS,
  })
  child.stderr.resume()
  return child
}
