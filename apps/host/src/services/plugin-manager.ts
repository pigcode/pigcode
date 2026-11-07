/**
 * 插件列表、卸载、启停与 boot graph；安装与更新在 plugin-installer.ts。
 *
 * 插件有两种来源：随应用内置的插件包（Claude Code、Codex 等，只能停用不能卸载），
 * 以及用户安装到 profile 的 `node_modules` 下的插件。用户安装的条目（连同它从哪里装的）与内置插件的
 * 启停状态都记在 profile 目录的 `plugins.yml` 里；内置插件的包目录由 Host 启动时传入。
 */
import { createHash } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { parse, stringify } from "yaml"
import {
  checkPluginCompatibility,
  parsePluginManifest,
  type PluginKind,
  type PluginManifest,
} from "@pigcode/plugin-sdk"
import { writeFileAtomic } from "./atomic-write"
import { enableConflictOf, resolveProvidesConflicts } from "./plugin-conflicts"
import { defaultPnpmRunner, readProfilePackage, type PnpmRunner } from "./plugin-npm"
import { describeSource, type PluginSource } from "./plugin-sources"

export type { PnpmRunner }

/** 插件的落盘位置：用户 profile 目录与内置插件包目录（绝对路径，按顺序加载）。 */
export interface PluginEnv {
  profileDir: string
  builtin: readonly string[]
}

/** 只给 profile 目录时没有内置插件，方便测试与旧调用方。 */
export type PluginEnvInput = PluginEnv | string

export function toEnv(input: PluginEnvInput): PluginEnv {
  return typeof input === "string" ? { profileDir: input, builtin: [] } : input
}

/** 插件从哪里装的：某个插件市场里的一项，或者一个直接的来源；更新时按它重新安装。 */
export type PluginOrigin =
  { kind: "marketplace"; marketplace: string; plugin: string } | PluginSource

/** plugins.yml 里的一条记录；内置插件只记录启停状态。 */
export interface InstalledPluginEntry {
  id: string
  name: string
  config?: unknown
  disabled?: boolean
  builtin?: boolean
  origin?: PluginOrigin
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
  /**
   * provides 冲突原因：同一个服务标识已由加载顺序更靠前的插件占用。
   * 有冲突的插件不加载 Host 入口与界面代码；先加载的那个不受影响。
   */
  conflict: string | null
  /** 用户安装的插件从哪里装的；内置插件与旧记录为 null。 */
  origin: PluginOrigin | null
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
  /** 从哪里装的；内置插件与旧记录为 null。 */
  origin: PluginOrigin | null
  /** 来源的一句话说明，详情里显示。 */
  originLabel: string | null
}

/** provides 冲突；code 供 RPC 调用方与界面识别，message 与插件页上的原因相同。 */
export class PluginConflictError extends Error {
  readonly code = "PROVIDES_CONFLICT"

  constructor(reason: string) {
    super(`PROVIDES_CONFLICT: ${reason}`)
    this.name = "PluginConflictError"
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

/** 读取插件列表；文件不存在或读不懂时从空列表开始。 */
export async function readPluginList(profileDir: string): Promise<InstalledPluginEntry[]> {
  try {
    const parsed = parse(await readFile(join(profileDir, PLUGINS_FILE), "utf8")) as {
      plugins?: InstalledPluginEntry[]
    } | null
    return Array.isArray(parsed?.plugins) ? parsed.plugins : []
  } catch {
    return []
  }
}

/** 原子写回插件列表（临时文件 + fsync + 改名），进程中途退出也不会留下空的或半个文件。 */
export async function writePluginList(
  profileDir: string,
  plugins: InstalledPluginEntry[],
): Promise<void> {
  await writeFileAtomic(join(profileDir, PLUGINS_FILE), stringify({ plugins }))
}

/** 读取一个包目录里的 manifest，保留失败原因供界面展示。 */
export async function readManifestAt(
  dir: string,
): Promise<{ manifest: PluginManifest | null; error: string | null }> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
    const manifest = parsePluginManifest(raw)
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
      conflict: null,
      origin: null,
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
      conflict: null,
      origin: entry.origin ?? null,
    })
  }
  resolveProvidesConflicts(records)
  return records
}

/** 插件 Host 入口的绝对 URL；loader 直接 import，不依赖 profile 目录的解析作用域。 */
export function hostEntryUrl(record: PluginRecord): string | null {
  const host = record.manifest?.pigcode.host
  return host ? pathToFileURL(join(record.dir, host)).href : null
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
 * 切换插件的停用标记。启用前先按“当前启用集合 + 目标插件”计算 provides，重复时拒绝写入
 * （先加载的插件保留，启用失败的一方保持停用）。停用时反过来先让目标插件按“已停用”参与计算：
 * 它让出的服务如果先被别的插件拿走，它就不能再一起启用，否则会出现一个处于启用状态、
 * 却注定冲突不加载的插件。返回更新后的记录，供调用方立即加载/卸载。
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
    // 只会被“当前真在提供服务的插件”挡住：已经因冲突不加载的插件不算（它并没占着服务），
    // 停用的也不算。报错文案与插件页上的原因一致。
    const conflict = enableConflictOf(record, records)
    if (conflict) throw new PluginConflictError(conflict)
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

/** 来源的一句话说明：市场写成「插件 @ 市场」，其余是地址或路径。 */
function originLabel(origin: PluginOrigin | null): string | null {
  if (!origin) return null
  return origin.kind === "marketplace"
    ? `${origin.plugin}@${origin.marketplace}`
    : describeSource(origin)
}

/** 列出全部插件摘要；manifest 读取失败、不兼容或 provides 冲突时保留错误信息。 */
export async function listPlugins(input: PluginEnvInput): Promise<PluginSummary[]> {
  const records = await readPluginRecords(input)
  return records.map((record) => {
    const manifest = record.manifest
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
      conflict: record.conflict,
      // manifest/compat 错误优先展示，其次才是 provides 冲突。
      error: record.error ?? record.conflict,
      origin: record.origin,
      originLabel: originLabel(record.origin),
    }
  })
}

/**
 * 为已启用且带 client 入口的用户插件生成启动图。
 * main 的 pigcode-plugin:// 只伺服 profile 里的包，内置插件目前都只有 Host 入口。
 * `hostFailures` 是 Host 入口 import 或 apply 失败的插件 id：它们也不加载界面代码。
 */
export async function buildBootGraph(
  input: PluginEnvInput,
  hostFailures: ReadonlySet<string> = new Set(),
): Promise<{ entries: BootGraphEntry[] }> {
  const entries: BootGraphEntry[] = []
  for (const record of await readPluginRecords(input)) {
    const manifest = record.manifest
    // 出错（manifest 不可用、不兼容、provides 冲突、Host 入口加载失败）的插件不加载界面代码。
    if (record.disabled || record.builtin || record.error || record.conflict) continue
    if (hostFailures.has(record.id)) continue
    if (!manifest?.pigcode.client) continue
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
