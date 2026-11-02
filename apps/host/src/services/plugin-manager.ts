/**
 * 插件的安装（本地目录 / npm / tarball）、卸载、启停与 boot graph。
 *
 * 插件有两种来源：随应用内置的插件包（Claude Code、Codex 等，只能停用不能卸载），
 * 以及用户安装到 profile 的 `node_modules` 下的插件。用户安装的条目与内置插件的启停状态
 * 都记在 profile 目录的 `plugins.yml` 里；内置插件的包目录由 Host 启动时传入。
 */
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rm } from "node:fs/promises"
import { dirname, join, win32 } from "node:path"
import { pathToFileURL } from "node:url"
import { parse, stringify } from "yaml"
import {
  checkPluginCompatibility,
  pluginManifestSchema,
  type PluginKind,
  type PluginManifest,
} from "@pigcode/plugin-sdk"
import { writeFileAtomic } from "./atomic-write"
import { backupBeforeRename, migrateLegacyPluginEntries } from "./legacy-names"
import {
  defaultPnpmRunner,
  ensureProfilePackage,
  isTarballPath,
  packageNameFromSpec,
  readProfilePackage,
  resolveInstalledName,
  type PnpmRunner,
} from "./plugin-npm"
import { compileTypeScriptPlugin } from "./plugin-typescript"

export type { PnpmRunner }

/** 插件的落盘位置：用户 profile 目录与内置插件包目录（绝对路径，按顺序加载）。 */
export interface PluginEnv {
  profileDir: string
  builtin: readonly string[]
}

/** 只给 profile 目录时没有内置插件，方便测试与旧调用方。 */
export type PluginEnvInput = PluginEnv | string

function toEnv(input: PluginEnvInput): PluginEnv {
  return typeof input === "string" ? { profileDir: input, builtin: [] } : input
}

/** plugins.yml 里的一条记录；内置插件只记录启停状态。 */
export interface InstalledPluginEntry {
  id: string
  name: string
  config?: unknown
  disabled?: boolean
  builtin?: boolean
}

/** 合并内置与用户安装后的一条插件记录。 */
export interface PluginRecord {
  id: string
  name: string
  /** 插件包目录。 */
  dir: string
  builtin: boolean
  disabled: boolean
  config: unknown
  manifest: PluginManifest | null
  /** manifest 读取失败或与当前 Host 不兼容的原因。 */
  error: string | null
}

/** 渲染进程启动插件所需的单条 boot graph 记录。 */
export interface BootGraphEntry {
  id: string
  revision: string
  url: string
  inject: string[]
}

/** 插件管理界面展示的单条插件摘要。 */
export interface PluginSummary {
  id: string
  name: string
  /** manifest 的 displayName，缺省为包名。 */
  displayName: string
  description: string | null
  version: string
  kind: PluginKind
  enabled: boolean
  /** 随应用内置：可以停用，不能卸载。 */
  builtin: boolean
  /** manifest 声明的 API 版本；manifest 不可用时为 0。 */
  apiVersion: number
  /** 安装时需要展示给用户的权限列表。 */
  permissions: string[]
  /** 插件声明提供的服务标识，用于冲突检测与展示。 */
  provides: string[]
  /** 插件声明的贡献点，原样透传给界面展示。 */
  contributes: Record<string, unknown>
  /** provides 冲突原因；无冲突时为 null。 */
  conflict: string | null
  error: string | null
}

/** provides 冲突；code 供 RPC 调用方与界面识别，message 直接展示给用户。 */
export class PluginConflictError extends Error {
  readonly code = "PROVIDES_CONFLICT"
  /** 被重复声明的 provides 标识。 */
  readonly service: string
  /** 声明了同一标识的插件 id，按加载顺序排列。 */
  readonly pluginIds: string[]

  constructor(service: string, pluginIds: string[]) {
    super(`PROVIDES_CONFLICT: ${service} is provided by ${pluginIds.join(", ")}`)
    this.name = "PluginConflictError"
    this.service = service
    this.pluginIds = pluginIds
  }
}

/** 合法的插件种类，用于 manifest 缺失时从 id 前缀推断。 */
const PLUGIN_KINDS: readonly PluginKind[] = ["agent", "capability", "ui", "bundle"]

/** 从 `<kind>.<name>` 形式的 id 推断插件种类；无法识别时按 bundle 处理。 */
function kindFromId(id: string): PluginKind {
  const separator = id.indexOf(".")
  const prefix = separator === -1 ? id : id.slice(0, separator)
  return PLUGIN_KINDS.find((kind) => kind === prefix) ?? "bundle"
}

/** 插件列表文件名。 */
export const PLUGINS_FILE = "plugins.yml"

/** 插件 id：种类加包名。 */
export function pluginIdOf(manifest: PluginManifest): string {
  return `${manifest.pigcode.kind}.${manifest.name}`
}

/**
 * 读取插件列表；文件不存在时从空列表开始。还用旧插件 id（`provider.<包名>`）的列表就地迁移并写回，
 * 写回前先备份原文件（见 legacy-names.ts）。备份或写回失败时只记日志，这次照样返回迁移后的列表，
 * 下次读取或下一次修改插件列表时再写。
 */
async function readPluginList(profileDir: string): Promise<InstalledPluginEntry[]> {
  let plugins: InstalledPluginEntry[]
  try {
    const parsed = parse(await readFile(join(profileDir, PLUGINS_FILE), "utf8")) as {
      plugins?: InstalledPluginEntry[]
    } | null
    plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : []
  } catch {
    return []
  }
  const migrated = migrateLegacyPluginEntries(plugins)
  if (migrated.changed) await persistMigratedPluginList(profileDir, migrated.entries)
  return migrated.entries
}

/** 迁移后的插件列表写回文件；失败只记日志，见 readPluginList。 */
async function persistMigratedPluginList(
  profileDir: string,
  plugins: InstalledPluginEntry[],
): Promise<void> {
  const path = join(profileDir, PLUGINS_FILE)
  try {
    if (!(await backupBeforeRename(path))) {
      console.error(`[host] could not back up ${path}; keeping the migrated plugin list in memory`)
      return
    }
    await writePluginList(profileDir, plugins)
  } catch (error) {
    console.error(`[host] could not write the migrated plugin list to ${path}:`, error)
  }
}

/** 原子写回插件列表（临时文件 + fsync + 改名），进程中途退出也不会留下空的或半个文件。 */
async function writePluginList(profileDir: string, plugins: InstalledPluginEntry[]): Promise<void> {
  await writeFileAtomic(join(profileDir, PLUGINS_FILE), stringify({ plugins }))
}

/** 读取一个包目录里的 manifest，保留失败原因供界面展示。 */
async function readManifestAt(
  dir: string,
): Promise<{ manifest: PluginManifest | null; error: string | null }> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
    const manifest = pluginManifestSchema.parse(raw)
    // 不兼容时仍返回 manifest 供界面展示版本与权限，但把原因写进 error。
    return { manifest, error: checkPluginCompatibility(manifest) }
  } catch (error) {
    return {
      manifest: null,
      error: error instanceof Error ? error.message : "manifest unavailable",
    }
  }
}

/** 合并内置插件与用户安装的插件；内置插件在前，保持加载顺序稳定。 */
export async function readPluginRecords(input: PluginEnvInput): Promise<PluginRecord[]> {
  const env = toEnv(input)
  const list = await readPluginList(env.profileDir)
  const records: PluginRecord[] = []
  for (const dir of env.builtin) {
    const { manifest, error } = await readManifestAt(dir)
    const id = manifest ? pluginIdOf(manifest) : `bundle.${dir}`
    const override = list.find((entry) => entry.builtin && entry.id === id)
    records.push({
      id,
      name: manifest?.name ?? dir,
      dir,
      builtin: true,
      disabled: override?.disabled === true,
      config: override?.config ?? {},
      manifest,
      error,
    })
  }
  const builtinNames = new Set(records.map((record) => record.name))
  for (const entry of list) {
    if (entry.builtin || entry.id.startsWith("core.") || builtinNames.has(entry.name)) continue
    const dir = join(env.profileDir, "node_modules", entry.name)
    const { manifest, error } = await readManifestAt(dir)
    records.push({
      id: entry.id,
      name: manifest?.name ?? entry.name,
      dir,
      builtin: false,
      disabled: entry.disabled === true,
      config: entry.config ?? {},
      manifest,
      error,
    })
  }
  return records
}

/** 插件 Host 入口的绝对 URL；loader 直接 import，不依赖 profile 目录的解析作用域。 */
export function hostEntryUrl(record: PluginRecord): string | null {
  const host = record.manifest?.pigcode.host
  return host ? pathToFileURL(join(record.dir, host)).href : null
}

/** 内置插件的包名不能再从外部安装一份。 */
async function assertNotBuiltin(env: PluginEnv, name: string): Promise<void> {
  for (const dir of env.builtin) {
    const { manifest } = await readManifestAt(dir)
    if (manifest?.name === name) throw new Error(`PLUGIN_BUILTIN: ${name} is built into Pigcode`)
  }
}

/** 把 manifest 对应的条目写入插件列表；同 id 条目原位替换，避免重复。 */
async function addPluginEntry(
  env: PluginEnv,
  manifest: PluginManifest,
): Promise<InstalledPluginEntry> {
  const entry: InstalledPluginEntry = {
    id: pluginIdOf(manifest),
    name: manifest.name,
    config: {},
    disabled: false,
  }
  const list = await readPluginList(env.profileDir)
  const index = list.findIndex((item) => item.id === entry.id)
  if (index === -1) list.push(entry)
  else list[index] = entry
  await ensureProfilePackage(env.profileDir)
  await writePluginList(env.profileDir, list)
  return entry
}

/** 校验并复制本地插件目录到 profile，随后写入启用的条目。 */
export async function installLocalPlugin(
  input: PluginEnvInput,
  sourceDir: string,
): Promise<InstalledPluginEntry> {
  const env = toEnv(input)
  const manifest = pluginManifestSchema.parse(
    JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8")),
  )
  await assertNotBuiltin(env, manifest.name)
  const target = join(env.profileDir, "node_modules", manifest.name)
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(sourceDir, target, { recursive: true })
  await compileTypeScriptPlugin(target)
  return addPluginEntry(env, manifest)
}

/**
 * 安装插件：本地目录复制进 profile，其余 spec（npm 包名/版本、tarball）交给
 * `pnpm add`。runner 由调用方注入，测试不联网。
 */
export async function installPlugin(
  input: PluginEnvInput,
  spec: string,
  runPnpm: PnpmRunner = defaultPnpmRunner,
): Promise<InstalledPluginEntry> {
  const env = toEnv(input)
  const localPath = spec.startsWith("file:") ? spec.slice("file:".length) : spec
  // win32.isAbsolute 同时认 `/x`、`C:\x` 与 UNC 路径；Windows 的文件夹选择框返回的是盘符路径。
  const isLocal = spec.startsWith(".") || spec.startsWith("file:") || win32.isAbsolute(spec)
  if (isLocal && !isTarballPath(localPath)) {
    return installLocalPlugin(env, localPath)
  }
  const fromSpec = packageNameFromSpec(spec)
  if (fromSpec) await assertNotBuiltin(env, fromSpec)
  // pnpm add 需要 profile 中已有 package.json 作为安装作用域。
  await ensureProfilePackage(env.profileDir)
  const before = await readProfilePackage(env.profileDir)
  await runPnpm(["add", spec, "--dir", env.profileDir])
  const after = await readProfilePackage(env.profileDir)
  const name = resolveInstalledName(spec, before.dependencies ?? {}, after.dependencies ?? {})
  const packageDir = join(env.profileDir, "node_modules", name)
  const manifest = pluginManifestSchema.parse(
    JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")),
  )
  await assertNotBuiltin(env, manifest.name)
  await compileTypeScriptPlugin(packageDir)
  return addPluginEntry(env, manifest)
}

/**
 * 卸载用户安装的插件：移除列表条目与 profile 里的包（pnpm 装的走 `pnpm remove`）。
 * 内置插件只能停用。调用方负责先停掉已加载的 Host 入口。
 */
export async function uninstallPlugin(
  input: PluginEnvInput,
  id: string,
  runPnpm: PnpmRunner = defaultPnpmRunner,
): Promise<InstalledPluginEntry> {
  const env = toEnv(input)
  const record = (await readPluginRecords(env)).find((item) => item.id === id)
  if (!record) throw new Error(`plugin not found: ${id}`)
  if (record.builtin) throw new Error(`PLUGIN_BUILTIN: ${record.name} can only be disabled`)
  const list = await readPluginList(env.profileDir)
  const entry = list.find((item) => item.id === id) ?? { id, name: record.name }
  const dependencies = (await readProfilePackage(env.profileDir)).dependencies ?? {}
  if (record.name in dependencies) {
    await runPnpm(["remove", record.name, "--dir", env.profileDir])
  }
  await rm(join(env.profileDir, "node_modules", record.name), { recursive: true, force: true })
  await writePluginList(
    env.profileDir,
    list.filter((item) => item.id !== id),
  )
  return entry
}

/**
 * 汇总启用插件的 provides：服务标识 -> 声明它的插件 id。
 * manifest 不可用的条目没有可读声明，不参与冲突计算。
 */
export function collectProvides(records: readonly PluginRecord[]): Map<string, string[]> {
  const provides = new Map<string, string[]>()
  for (const record of records) {
    if (record.disabled) continue
    for (const service of record.manifest?.pigcode.provides ?? []) {
      const owners = provides.get(service) ?? []
      owners.push(record.id)
      provides.set(service, owners)
    }
  }
  return provides
}

/** 返回第一组重复的 provides；没有冲突时返回 null。 */
function findProvidesConflict(
  provides: Map<string, string[]>,
): { service: string; pluginIds: string[] } | null {
  for (const [service, pluginIds] of provides) {
    if (pluginIds.length > 1) return { service, pluginIds }
  }
  return null
}

/** 生成可展示给用户的冲突描述；插件自身的 provides 重复同样会命中。 */
function describeConflict(provides: Map<string, string[]>, services: string[]): string | null {
  const conflicts = services
    .map((service) => [service, provides.get(service) ?? []] as const)
    .filter(([, pluginIds]) => pluginIds.length > 1)
    .map(([service, pluginIds]) => `${service} is provided by ${pluginIds.join(", ")}`)
  return conflicts.length > 0 ? `PROVIDES_CONFLICT: ${conflicts.join("; ")}` : null
}

/**
 * 切换插件的停用标记。启用前先按“当前启用集合 + 目标插件”计算 provides，重复时拒绝写入。
 * 返回更新后的记录，供调用方立即加载/卸载。
 */
export async function setPluginEnabled(
  input: PluginEnvInput,
  id: string,
  enabled: boolean,
): Promise<PluginRecord> {
  const env = toEnv(input)
  const records = await readPluginRecords(env)
  const record = records.find((item) => item.id === id)
  if (!record) throw new Error(`plugin not found: ${id}`)
  if (enabled) {
    const effective = records.map((item) => (item.id === id ? { ...item, disabled: false } : item))
    const conflict = findProvidesConflict(collectProvides(effective))
    if (conflict) throw new PluginConflictError(conflict.service, conflict.pluginIds)
  }
  const list = await readPluginList(env.profileDir)
  const existing = list.find((item) => item.id === id)
  if (existing) existing.disabled = !enabled
  else
    list.push({
      id,
      name: record.name,
      disabled: !enabled,
      ...(record.builtin ? { builtin: true } : {}),
    })
  await writePluginList(env.profileDir, list)
  return { ...record, disabled: !enabled }
}

/** 列出全部插件摘要；manifest 读取失败时保留错误信息。 */
export async function listPlugins(input: PluginEnvInput): Promise<PluginSummary[]> {
  const records = await readPluginRecords(input)
  const provides = collectProvides(records)
  return records.map((record) => {
    const manifest = record.manifest
    const conflict = describeConflict(provides, manifest?.pigcode.provides ?? [])
    return {
      id: record.id,
      name: manifest?.name ?? record.name,
      displayName: manifest?.pigcode.displayName ?? manifest?.name ?? record.name,
      description: manifest?.description ?? null,
      version: manifest?.version ?? "0.0.0",
      kind: manifest?.pigcode.kind ?? kindFromId(record.id),
      enabled: !record.disabled,
      builtin: record.builtin,
      apiVersion: manifest?.pigcode.apiVersion ?? 0,
      permissions: manifest?.pigcode.permissions ?? [],
      provides: manifest?.pigcode.provides ?? [],
      contributes: manifest?.pigcode.contributes ?? {},
      conflict,
      // manifest/compat 错误优先展示，其次才是冲突。
      error: record.error ?? conflict,
    }
  })
}

/**
 * 为已启用且带 client 入口的用户插件生成启动图。
 * main 的 pigcode-plugin:// 只伺服 profile 里的包，内置插件目前都只有 Host 入口。
 */
export async function buildBootGraph(
  input: PluginEnvInput,
): Promise<{ entries: BootGraphEntry[] }> {
  const entries: BootGraphEntry[] = []
  for (const record of await readPluginRecords(input)) {
    const manifest = record.manifest
    if (record.disabled || record.builtin || !manifest?.pigcode.client) continue
    const revision = createHash("sha256")
      .update(await readFile(join(record.dir, manifest.pigcode.client)))
      .digest("hex")
      .slice(0, 12)
    const clientEntry = manifest.pigcode.client.replace(/^\.\//, "")
    entries.push({
      id: record.id,
      revision,
      url: `pigcode-plugin://plugins/${encodeURIComponent(manifest.name)}/${clientEntry}?rev=${revision}`,
      inject: manifest.pigcode.inject,
    })
  }
  return { entries }
}
