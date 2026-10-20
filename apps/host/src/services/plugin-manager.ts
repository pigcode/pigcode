/** 本地插件安装、启停与 boot graph 构建；M0 只支持本地目录。 */
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { parse, stringify } from "yaml"
import {
  checkPluginCompatibility,
  pluginManifestSchema,
  type PluginManifest,
} from "@pigcode/plugin-sdk"

/** profile 中记录的单条已安装插件。 */
export interface InstalledPluginEntry {
  id: string
  name: string
  config?: unknown
  disabled?: boolean
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
  version: string
  kind: "provider" | "capability" | "ui" | "bundle"
  enabled: boolean
  /** manifest 声明的 API 版本；manifest 不可用时为 0。 */
  apiVersion: number
  /** 安装时需要展示给用户的权限列表。 */
  permissions: string[]
  /** 插件声明提供的能力标识，用于冲突检测与展示。 */
  provides: string[]
  /** 插件声明的贡献点，原样透传给 UI 展示。 */
  contributes: Record<string, unknown>
  /** provides 冲突原因；无冲突时为 null。 */
  conflict: string | null
  error: string | null
}

/** provides 冲突；code 供 RPC 调用方与界面识别，message 直接展示给用户。 */
export class PluginConflictError extends Error {
  readonly code = "PROVIDES_CONFLICT"
  /** 发生重复的能力标识。 */
  readonly capability: string
  /** 声明了同一能力的插件 id，按 profile 顺序排列。 */
  readonly pluginIds: string[]

  constructor(capability: string, pluginIds: string[]) {
    super(`PROVIDES_CONFLICT: ${capability} is provided by ${pluginIds.join(", ")}`)
    this.name = "PluginConflictError"
    this.capability = capability
    this.pluginIds = pluginIds
  }
}

/** 合法的插件种类，用于 manifest 缺失时从 id 前缀推断。 */
const PLUGIN_KINDS: readonly PluginSummary["kind"][] = ["provider", "capability", "ui", "bundle"]

/** 从 `<kind>.<name>` 形式的 id 推断插件种类；无法识别时按 bundle 处理。 */
function kindFromId(id: string): PluginSummary["kind"] {
  const separator = id.indexOf(".")
  const prefix = separator === -1 ? id : id.slice(0, separator)
  return PLUGIN_KINDS.find((kind) => kind === prefix) ?? "bundle"
}

/** profile 文件名；与 kernel 的 profile 加载约定保持一致。 */
const PROFILE_FILE = "desktop.yml"

/** 读取 profile；文件不存在时从空插件列表开始。 */
async function readProfile(profileDir: string): Promise<{ plugins: InstalledPluginEntry[] }> {
  const path = join(profileDir, PROFILE_FILE)
  try {
    return parse(await readFile(path, "utf8")) as { plugins: InstalledPluginEntry[] }
  } catch {
    return { plugins: [] }
  }
}

/** 写回 profile，必要时先创建目录。 */
async function writeProfile(
  profileDir: string,
  profile: { plugins: InstalledPluginEntry[] },
): Promise<void> {
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, PROFILE_FILE), stringify(profile), "utf8")
}

/** 校验并复制本地插件到 profile，随后写入启用的条目。 */
export async function installLocalPlugin(
  profileDir: string,
  sourceDir: string,
): Promise<InstalledPluginEntry> {
  const manifest = pluginManifestSchema.parse(
    JSON.parse(await readFile(join(sourceDir, "package.json"), "utf8")),
  )
  const target = join(profileDir, "node_modules", manifest.name)
  await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(sourceDir, target, { recursive: true })
  const entry: InstalledPluginEntry = {
    id: `${manifest.pigcode.kind}.${manifest.name}`,
    name: manifest.name,
    config: {},
    disabled: false,
  }
  const profile = await readProfile(profileDir)
  profile.plugins = [...profile.plugins.filter((item) => item.id !== entry.id), entry]
  await writeProfile(profileDir, profile)
  return entry
}

/**
 * 汇总启用插件的 provides：能力标识 -> 声明它的插件 id。
 * manifest 不可用的条目没有可读声明，不参与冲突计算。
 */
export async function collectProvides(
  profileDir: string,
  profile: { plugins: InstalledPluginEntry[] },
): Promise<Map<string, string[]>> {
  const provides = new Map<string, string[]>()
  for (const entry of profile.plugins) {
    if (entry.disabled) continue
    const manifest = await readInstalledManifest(profileDir, entry)
    for (const capability of manifest?.pigcode.provides ?? []) {
      const owners = provides.get(capability) ?? []
      owners.push(entry.id)
      provides.set(capability, owners)
    }
  }
  return provides
}

/** 返回第一组重复的 provides；没有冲突时返回 null。 */
function findProvidesConflict(
  provides: Map<string, string[]>,
): { capability: string; pluginIds: string[] } | null {
  for (const [capability, pluginIds] of provides) {
    if (pluginIds.length > 1) return { capability, pluginIds }
  }
  return null
}

/** 生成可展示给用户的冲突描述；插件自身的 provides 重复同样会命中。 */
function describeConflict(provides: Map<string, string[]>, capabilities: string[]): string | null {
  const conflicts = capabilities
    .map((capability) => [capability, provides.get(capability) ?? []] as const)
    .filter(([, pluginIds]) => pluginIds.length > 1)
    .map(([capability, pluginIds]) => `${capability} is provided by ${pluginIds.join(", ")}`)
  return conflicts.length > 0 ? `PROVIDES_CONFLICT: ${conflicts.join("; ")}` : null
}

/**
 * 切换插件的 disabled 标记。
 * 启用前先按“当前启用集合 + 目标插件”计算 provides，重复时拒绝写入 profile。
 */
export async function setPluginEnabled(
  profileDir: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  const profile = await readProfile(profileDir)
  const entry = profile.plugins.find((item) => item.id === id)
  if (!entry) throw new Error(`plugin not found: ${id}`)
  if (enabled) {
    const effective = profile.plugins.map((item) =>
      item.id === id ? { ...item, disabled: false } : item,
    )
    const conflict = findProvidesConflict(await collectProvides(profileDir, { plugins: effective }))
    if (conflict) throw new PluginConflictError(conflict.capability, conflict.pluginIds)
  }
  entry.disabled = !enabled
  await writeProfile(profileDir, profile)
}

/**
 * 列出用户安装的插件摘要；manifest 读取失败时保留错误信息。
 * core.* 是 Host 内部服务入口，不属于 UI 可管理的插件，不在这里展示。
 */
export async function listPlugins(profileDir: string): Promise<PluginSummary[]> {
  const profile = await readProfile(profileDir)
  const provides = await collectProvides(profileDir, profile)
  const summaries: PluginSummary[] = []
  for (const entry of profile.plugins) {
    if (entry.id.startsWith("core.")) continue
    const { manifest, error } = await readManifestState(profileDir, entry)
    const conflict = describeConflict(provides, manifest?.pigcode.provides ?? [])
    summaries.push({
      id: entry.id,
      name: manifest?.name ?? entry.name,
      version: manifest?.version ?? "0.0.0",
      kind: manifest?.pigcode.kind ?? kindFromId(entry.id),
      enabled: !entry.disabled,
      apiVersion: manifest?.pigcode.apiVersion ?? 0,
      permissions: manifest?.pigcode.permissions ?? [],
      provides: manifest?.pigcode.provides ?? [],
      contributes: manifest?.pigcode.contributes ?? {},
      conflict,
      // manifest/compat 错误优先展示，其次才是冲突。
      error: error ?? conflict,
    })
  }
  return summaries
}

/** 为已启用且带 client 入口的插件生成启动图。 */
export async function buildBootGraph(profileDir: string): Promise<{ entries: BootGraphEntry[] }> {
  const profile = await readProfile(profileDir)
  const entries: BootGraphEntry[] = []
  for (const entry of profile.plugins) {
    if (entry.disabled) continue
    const manifest = await readInstalledManifest(profileDir, entry)
    if (!manifest?.pigcode.client) continue
    const clientPath = join(profileDir, "node_modules", manifest.name, manifest.pigcode.client)
    const revision = createHash("sha256")
      .update(await readFile(clientPath))
      .digest("hex")
      .slice(0, 12)
    const clientEntry = manifest.pigcode.client.replace(/^\.\//, "")
    entries.push({
      id: entry.id,
      revision,
      url: `pigcode-plugin://plugins/${encodeURIComponent(manifest.name)}/${clientEntry}?rev=${revision}`,
      inject: manifest.pigcode.inject,
    })
  }
  return { entries }
}

/** 读取已安装插件目录中的 manifest；核心 profile 条目没有对应包时返回 null。 */
async function readInstalledManifest(
  profileDir: string,
  entry: InstalledPluginEntry,
): Promise<PluginManifest | null> {
  return (await readManifestState(profileDir, entry)).manifest
}

/** 读取 manifest 并保留失败原因，供插件摘要展示。 */
async function readManifestState(
  profileDir: string,
  entry: InstalledPluginEntry,
): Promise<{ manifest: PluginManifest | null; error: string | null }> {
  const path = join(profileDir, "node_modules", entry.name, "package.json")
  try {
    const manifest = pluginManifestSchema.parse(JSON.parse(await readFile(path, "utf8")))
    // 不兼容时仍返回 manifest 供界面展示版本与权限，但把原因写进 error。
    return { manifest, error: checkPluginCompatibility(manifest) }
  } catch (error) {
    return {
      manifest: null,
      error: error instanceof Error ? error.message : "manifest unavailable",
    }
  }
}
