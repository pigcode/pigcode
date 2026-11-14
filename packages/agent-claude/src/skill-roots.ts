/** Claude 本地的 Skill 来源，包括已启用插件的标准目录和 manifest 声明的目录。 */
import { readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { expandHome } from "@pigcode/plugin-sdk/node"
import JSON5 from "json5"
import { z } from "zod"

const skillOverride = z.enum(["on", "name-only", "user-invocable-only", "off"])
const skillSettings = z.object({
  enabledPlugins: z.record(z.string(), z.unknown()).optional(),
  skillOverrides: z.record(z.string(), skillOverride).optional().catch(undefined),
})

const pluginRegistry = z.object({ plugins: z.record(z.string(), z.array(z.unknown())) })
const installRecord = z.object({
  installPath: z.string().min(1),
  scope: z.enum(["user", "managed", "project", "local"]),
  projectPath: z.string().optional(),
})
const pluginManifest = z.object({
  name: z.string().trim().min(1).optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
})

export interface SkillRoot {
  directory: string
  scope: "system" | "user" | "project"
  plugin?: { name: string; id: string }
}

export interface ClaudeSkillSource {
  cwd: string | null
  env?: NodeJS.ProcessEnv | undefined
  extraArgs?: Record<string, string | null> | undefined
}

async function readSettings<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
  try {
    const parsed = schema.safeParse(JSON5.parse(await readFile(path, "utf8")))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function inside(directory: string, target: string): boolean {
  const path = relative(directory, target)
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path)
}

/** 从工作目录找到 Git 根目录。链接工作树与主仓库使用同一套项目插件安装记录。 */
async function projectDirectories(
  cwd: string,
): Promise<{ root: string; common: string; cwd: string }> {
  const start = await realpath(cwd).catch(() => resolve(cwd))
  for (let directory = start; ; directory = dirname(directory)) {
    const marker = join(directory, ".git")
    const entry = await stat(marker).catch(() => undefined)
    if (entry) {
      if (entry.isFile()) {
        const contents = await readFile(marker, "utf8").catch(() => "")
        const gitdir = /^gitdir:\s*(.+)/.exec(contents)?.[1]?.trim()
        if (gitdir) {
          const gitPath = resolve(directory, gitdir)
          const common = await readFile(join(gitPath, "commondir"), "utf8").catch(() => "")
          const commonPath = resolve(gitPath, common.trim())
          const backlink = await readFile(join(gitPath, "gitdir"), "utf8").catch(() => "")
          if (
            common.trim() &&
            basename(commonPath) === ".git" &&
            dirname(gitPath) === join(commonPath, "worktrees") &&
            backlink.trim() &&
            (await realpath(resolve(gitPath, backlink.trim())).catch(() => null)) === marker
          ) {
            return { root: directory, common: dirname(commonPath), cwd: start }
          }
        }
      }
      return { root: directory, common: directory, cwd: start }
    }
    if (directory === dirname(directory)) return { root: start, common: start, cwd: start }
  }
}

function managedConfigDir(env: NodeJS.ProcessEnv): string | undefined {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode"
    case "win32": {
      const programFiles = windowsEnv(env, "programfiles")
      return programFiles ? join(programFiles, "ClaudeCode") : undefined
    }
    default:
      return "/etc/claude-code"
  }
}

function windowsEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env)
    .find(([key]) => key.toLowerCase() === name)?.[1]
    ?.trim()
}

async function pluginRoots(
  path: string,
  scope: SkillRoot["scope"],
  id: string,
): Promise<SkillRoot[]> {
  const install = await realpath(path).catch(() => undefined)
  if (!install) return []
  const manifest = await readSettings(
    join(install, ".claude-plugin", "plugin.json"),
    pluginManifest,
  )
  const name = manifest?.name ?? id.split("@", 1)[0]
  if (!name) return []
  const declared =
    typeof manifest?.skills === "string" ? [manifest.skills] : (manifest?.skills ?? [])
  const defaults = await stat(join(install, "skills")).then(
    (entry) => (entry.isDirectory() ? ["skills"] : []),
    () => [],
  )
  // 一个插件也可以只包含根目录下的一份 SKILL.md。
  const dirs = [...new Set([...defaults, ...declared])]
  if (dirs.length === 0 && (await stat(join(install, "SKILL.md")).catch(() => null))) dirs.push(".")
  const roots: SkillRoot[] = []
  for (const dir of dirs) {
    const candidate = resolve(install, dir)
    if (!inside(install, candidate)) continue
    const directory = await realpath(candidate).catch(() => undefined)
    if (directory && inside(install, directory))
      roots.push({ directory, scope, plugin: { name, id } })
  }
  return roots
}

export async function claudeSkillRoots({ cwd, env = process.env, extraArgs }: ClaudeSkillSource) {
  const project = cwd ? await projectDirectories(cwd) : null
  const workDir = project?.cwd
  const config = env.CLAUDE_CONFIG_DIR?.trim()
  const home = config ? resolve(workDir ?? process.cwd(), config) : join(homedir(), ".claude")
  const managed = managedConfigDir(env)
  const programData = process.platform === "win32" ? windowsEnv(env, "programdata") : undefined
  // 先读项目根，再读到当前目录。只有同一个 Git 仓库内的父目录参与解析。
  const projectSettings: string[] = []
  if (project) {
    for (let directory = project.cwd; ; directory = dirname(directory)) {
      projectSettings.push(join(directory, ".claude"))
      if (directory === project.root) break
    }
  }
  const settingsPaths = [
    join(home, "settings.json"),
    ...[...projectSettings]
      .reverse()
      .flatMap((directory) => [
        join(directory, "settings.json"),
        join(directory, "settings.local.json"),
      ]),
    ...(programData ? [join(programData, "ClaudeCode", "managed-settings.json")] : []),
    ...(managed ? [join(managed, "managed-settings.json")] : []),
  ]
  const settings = await Promise.all(settingsPaths.map((path) => readSettings(path, skillSettings)))
  const overrides = new Map<string, z.infer<typeof skillOverride>>()
  const enabled = new Map<string, unknown>()
  for (const setting of settings) {
    for (const [name, value] of Object.entries(setting?.skillOverrides ?? {})) {
      overrides.set(name, value)
    }
    for (const [id, value] of Object.entries(setting?.enabledPlugins ?? {})) {
      enabled.set(id, value)
    }
  }
  const roots: SkillRoot[] = [
    ...(managed
      ? [{ directory: join(managed, ".claude", "skills"), scope: "system" as const }]
      : []),
    { directory: join(home, "skills"), scope: "user" },
    ...projectSettings.map((directory) => ({
      directory: join(directory, "skills"),
      scope: "project" as const,
    })),
  ]
  const additional = extraArgs?.["add-dir"]
  if (additional && (workDir || isAbsolute(expandHome(additional)))) {
    roots.push({
      directory: resolve(workDir ?? process.cwd(), expandHome(additional), ".claude", "skills"),
      scope: "project",
    })
  }

  const cache = env.CLAUDE_CODE_PLUGIN_CACHE_DIR?.trim()
  const registry = join(
    cache ? resolve(workDir ?? process.cwd(), expandHome(cache)) : join(home, "plugins"),
    "installed_plugins.json",
  )
  const installed = (await readSettings(registry, pluginRegistry))?.plugins ?? {}
  const projectChecks = new Map<string, ReturnType<typeof projectDirectories>>()
  for (const id of Object.keys(installed).sort()) {
    if (enabled.get(id) !== true) continue
    for (const record of installed[id] ?? []) {
      const decoded = installRecord.safeParse(record)
      if (!decoded.success) continue
      const install = decoded.data
      const user = install.scope === "user" || install.scope === "managed"
      if (!user) {
        if (!project || !install.projectPath) continue
        const path = resolve(install.projectPath)
        let check = projectChecks.get(path)
        if (!check) {
          check = projectDirectories(path)
          projectChecks.set(path, check)
        }
        if ((await check).common !== project.common) continue
      }
      const paths = await pluginRoots(
        resolve(workDir ?? process.cwd(), install.installPath),
        user ? "user" : "project",
        id,
      )
      if (paths.length > 0) {
        roots.push(...paths)
        break
      }
    }
  }
  const extraPlugin = extraArgs?.["plugin-dir"]
  if (extraPlugin) {
    const path = resolve(workDir ?? process.cwd(), expandHome(extraPlugin))
    roots.push(...(await pluginRoots(path, "project", basename(path))))
  }
  return { roots, overrides }
}
