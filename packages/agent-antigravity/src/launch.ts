import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { randomUUID } from "node:crypto"
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, isAbsolute, join, resolve } from "node:path"
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

export async function instanceProfile(instance: AgentInstanceContext): Promise<AgyProfile> {
  const id = await readFile(join(instance.dataDir, PROFILE_ID), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "initial"
      throw error
    },
  )
  if (!/^(?:initial|[a-f0-9-]{36})$/.test(id)) throw new Error("Invalid Antigravity instance data")
  return profilePath(instance, id)
}

/** 只在完成 ACP 验证后切换目录。 */
export async function activateProfile(
  instance: AgentInstanceContext,
  profile: AgyProfile,
  signal: AbortSignal,
): Promise<void> {
  const id = basename(profile.directory)
  const temporary = join(instance.dataDir, `.${id}`)
  try {
    await writeFile(temporary, id, { flag: "wx", mode: 0o600, signal })
    signal.throwIfAborted()
    await rename(temporary, join(instance.dataDir, PROFILE_ID))
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

export interface AgyLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

export async function acpLaunch(
  command: string,
  settings: AgentSettingsValues,
  profile: AgyProfile,
  cwd: string,
): Promise<AgyLaunch> {
  const data = join(profile.directory, ACP_DATA_DIR)
  await mkdir(data, { recursive: true, mode: 0o700 })
  // 原生 logout 读取这个字段来清理本次采用的登录方式。
  await writeFile(
    join(data, "settings.json"),
    JSON.stringify({ auth: { type: "oauth-personal" } }),
    {
      flag: "wx",
      mode: 0o600,
    },
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error
  })
  const env = agentEnvironment(settingEnvironment(settings))
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
    args: ["acp", "--gemini-dir", profile.directory, "--app-data-dir", ACP_DATA_DIR],
    env: {
      ...env,
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
