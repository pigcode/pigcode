import { lstat, mkdir, readdir, readlink, realpath, stat, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import {
  settingEnvironment,
  settingString,
  type AgentInstanceContext,
  type AgentSettingsValues,
} from "@pigcode/plugin-sdk"
import { expandHome } from "@pigcode/plugin-sdk/node"

const sharedDirectories = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
  "thread-writer-locks",
]
const privateFiles = new Set(["auth.json", "auth.lock", "models_cache.json"])
const localNames = new Set([...privateFiles, "log", "memories", "tmp", ".DS_Store"])

export function sharedCodexHome(settings?: AgentSettingsValues): string {
  const fromEnv = settingEnvironment(settings).find(({ name }) => name === "CODEX_HOME")?.value
  return resolve(
    expandHome(
      settingString(settings, "homePath") ||
        fromEnv ||
        process.env.CODEX_HOME ||
        join(homedir(), ".codex"),
    ),
  )
}

export function shadowCodexHome(
  settings?: AgentSettingsValues,
  instance?: AgentInstanceContext,
): string | undefined {
  if (settings?.setupMode === "managed") {
    if (!instance) throw new Error("A managed Codex account needs its own instance directory")
    return join(instance.dataDir, "codex-home")
  }
  const configured = settingString(settings, "shadowHomePath")
  return configured ? resolve(expandHome(configured)) : undefined
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT"
}

/** 路径还不存在时也解析其父目录，避免经过软链接把两个 home 嵌套起来。 */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    if (!missing(error) || dirname(path) === path) throw error
    return join(await canonical(dirname(path)), basename(path))
  }
}

function contains(root: string, target: string) {
  const diff = relative(root, target)
  return !isAbsolute(diff) && diff !== ".." && !diff.startsWith(".." + sep)
}

async function checkLink(link: string, target: string): Promise<boolean> {
  const entry = await lstat(link).catch((error) => {
    if (missing(error)) return null
    throw error
  })
  if (!entry) return false
  if (
    entry.isSymbolicLink() &&
    relative(resolve(dirname(link), await readlink(link)), target) === ""
  )
    return true
  throw new Error("Codex shadow home already contains a conflicting entry: " + link)
}

/** 先检查全部路径，再建立共享状态链接，凭据保留在各自的账号目录内。 */
export async function prepareShadowHome(sharedPath: string, shadowPath: string): Promise<void> {
  const [shared, shadow] = await Promise.all([canonical(sharedPath), canonical(shadowPath)])
  if (contains(shared, shadow) || contains(shadow, shared))
    throw new Error("Codex shared and shadow homes must be separate directories")
  await Promise.all([
    mkdir(shared, { recursive: true, mode: 0o700 }),
    mkdir(shadow, { recursive: true, mode: 0o700 }),
  ])
  for (const name of privateFiles) {
    const path = join(shadow, name)
    const entry = await lstat(path).catch((error) => {
      if (missing(error)) return null
      throw error
    })
    if (entry && (!entry.isFile() || entry.nlink !== 1))
      throw new Error("Codex credentials need a private file: " + path)
  }
  const names = new Set([...sharedDirectories, ...(await readdir(shared))])
  const pending: { link: string; target: string; directory: boolean }[] = []
  for (const name of names) {
    if (localNames.has(name)) continue
    const link = join(shadow, name)
    const target = join(shared, name)
    const resolved = await canonical(target)
    if (
      contains(shadow, resolved) ||
      contains(resolved, shadow) ||
      contains(resolved, shared) ||
      [...privateFiles].some((privateName) => relative(join(shared, privateName), resolved) === "")
    )
      throw new Error("Codex shared entry points into private account state: " + target)
    const targetInfo = await stat(target).catch((error) => {
      if (missing(error)) return undefined
      throw error
    })
    if (!targetInfo && !sharedDirectories.includes(name)) continue
    if (targetInfo && sharedDirectories.includes(name) && !targetInfo.isDirectory())
      throw new Error("Codex shared state requires a directory: " + target)
    if (await checkLink(link, target)) continue
    const directory = targetInfo?.isDirectory() ?? true
    pending.push({ link, target, directory })
  }
  for (const { link, target, directory } of pending) {
    if (sharedDirectories.includes(basename(target)))
      await mkdir(target, { recursive: true, mode: 0o700 })
    try {
      await symlink(
        target,
        link,
        directory ? (process.platform === "win32" ? "junction" : "dir") : "file",
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !(await checkLink(link, target)))
        throw error
    }
  }
}
