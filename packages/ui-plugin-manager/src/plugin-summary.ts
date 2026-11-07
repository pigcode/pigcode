// 插件页展示的插件摘要与插件市场，以及卡片和详情共用的状态、类型、说明文案、版本比较和错误说明。
import type { Locale, MessageKey, StatusTone } from "@pigcode/ui-primitives"

/** 插件类型，与 Host 的 boot graph 保持一致。 */
export type PluginKind = "agent" | "capability" | "ui" | "bundle"

/** 扩展点名称，与 client-runtime 的 ExtensionPoint 一致。 */
export type PluginExtensionPoint = "panel" | "surface" | "settingsPage" | "command" | "toolRenderer"

/** 插件在某个扩展点上被拒绝的一次登记：id 已经属于 owner。 */
export interface PluginContributionConflict {
  point: PluginExtensionPoint
  id: string
  owner: { kind: "builtin" | "plugin"; id: string }
}

/** 插件的界面代码在窗口里出的错：没有加载成功，或 apply 抛了错。detail 是原因。 */
export interface PluginClientError {
  kind: "import" | "apply" | "command"
  detail: string
}

/** 插件从哪里装的；与 Host 的 PluginOrigin 一致。 */
export type PluginOrigin =
  | { kind: "marketplace"; marketplace: string; plugin: string }
  | { kind: "local"; path: string }
  | { kind: "npm"; spec: string }
  | { kind: "github"; owner: string; repo: string; ref?: string; path?: string }
  | { kind: "git"; url: string; ref?: string; path?: string }
  | { kind: "archive"; url: string; sha256?: string }

/** 插件页展示的插件摘要；字段与 Host 的 PluginSummary 对齐。 */
export interface PluginSummary {
  id: string
  name: string
  /** manifest 的 displayName；旧 Host 没有这个字段时用包名。 */
  displayName?: string
  description?: string | null
  version: string
  kind: PluginKind
  enabled: boolean
  /** 随应用内置：可以停用，不能卸载。 */
  builtin?: boolean
  /** manifest 声明的 API 版本；manifest 不可用时为 0。 */
  apiVersion: number
  /** 安装时需要展示给用户的权限列表。 */
  permissions: string[]
  /** 插件声明提供的服务标识，用于冲突检测与展示。 */
  provides: string[]
  /** 插件声明的贡献点，原样透传。 */
  contributes: Record<string, unknown>
  /** provides 冲突原因；无冲突时为 null。 */
  conflict: string | null
  error: string | null
  /** 窗口里扩展点登记的冲突；由宿主从扩展点注册表填入，Host 的列表里没有。 */
  contributionConflicts?: readonly PluginContributionConflict[]
  /** 窗口里界面代码出的错；由宿主的插件控制器填入。 */
  clientErrors?: readonly PluginClientError[]
  /** 卡片上「打开」去的设置页 id；由宿主按扩展点注册表填入，没有时不显示「打开」。 */
  settingsPage?: string
  /** 从哪里装的；内置插件与旧记录为 null。有它才能更新。 */
  origin?: PluginOrigin | null
  /** 来源的一句话说明。 */
  originLabel?: string | null
}

/** 插件市场里的一个插件；与 Host 的 MarketplaceEntry 一致。 */
export interface MarketplacePlugin {
  name: string
  displayName: string | null
  description: string | null
  version: string | null
  category: string | null
  icon: string | null
  homepage: string | null
  author: string | null
  sourceLabel: string
}

/** 一个插件市场；与 Host 的 MarketplaceSummary 一致。 */
export interface MarketplaceSummary {
  id: string
  displayName: string
  description: string | null
  owner: string | null
  sourceType: "github" | "git" | "url" | "directory" | "file"
  sourceLabel: string
  /** 在浏览器里打开来源的地址；本地来源为 null。 */
  sourceUrl?: string | null
  /** 本地来源的路径，在文件夹中显示；远程来源为 null。 */
  sourcePath?: string | null
  /** 停用的市场不在插件市场里列出，也不检查更新；旧 Host 没有这个字段时视为启用。 */
  enabled?: boolean
  addedAt: string
  lastUpdated: string | null
  error: string | null
  plugins: MarketplacePlugin[]
}

/** 市场是否启用。 */
export function isMarketEnabled(market: MarketplaceSummary): boolean {
  return market.enabled !== false
}

/** 市场源管理里的顺序：启用的在前，同一组里最近刷新的在前，从没刷新过的沉底，再按名字。 */
export function sortSources(markets: readonly MarketplaceSummary[]): MarketplaceSummary[] {
  return [...markets].sort(
    (left, right) =>
      Number(isMarketEnabled(right)) - Number(isMarketEnabled(left)) ||
      (right.lastUpdated ?? "").localeCompare(left.lastUpdated ?? "") ||
      left.displayName.localeCompare(right.displayName),
  )
}

/** 市场来源类型的文案。 */
export const sourceTypeKeys: Record<MarketplaceSummary["sourceType"], MessageKey> = {
  github: "plugins.market.source.github",
  git: "plugins.market.source.git",
  url: "plugins.market.source.url",
  directory: "plugins.market.source.directory",
  file: "plugins.market.source.file",
}

/** 版本号拆成数字段与预发布标记；读不出数字时为 null。 */
function versionParts(version: string): { numbers: number[]; pre: string } | null {
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim())
  if (!match) return null
  return { numbers: (match[1] ?? "").split(".").map(Number), pre: match[2] ?? "" }
}

/** candidate 是不是比 installed 新；有一边读不出来时按字符串是否不同判断。 */
export function isNewerVersion(candidate: string, installed: string): boolean {
  const next = versionParts(candidate)
  const current = versionParts(installed)
  if (!next || !current) return candidate.trim() !== installed.trim()
  const length = Math.max(next.numbers.length, current.numbers.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (next.numbers[index] ?? 0) - (current.numbers[index] ?? 0)
    if (difference !== 0) return difference > 0
  }
  // 1.0.0 比 1.0.0-beta 新；两边都是预发布时按字典序。
  if (next.pre === current.pre) return false
  if (!next.pre) return true
  if (!current.pre) return false
  return next.pre > current.pre
}

/** 已安装的插件在市场里有没有更新：从这个市场装的，而且市场里的版本更新。 */
export function updateFor(
  plugin: PluginSummary | undefined,
  market: MarketplaceSummary,
  entry: MarketplacePlugin,
): boolean {
  if (!plugin?.origin || plugin.origin.kind !== "marketplace" || !entry.version) return false
  return plugin.origin.marketplace === market.id && isNewerVersion(entry.version, plugin.version)
}

/** 有说明文案的错误码；Host 的错误消息形如 `CODE: 细节`。 */
const ERROR_CODES = new Set([
  "PLUGIN_GITHUB_NOT_FOUND",
  "PLUGIN_GITHUB_RATE_LIMITED",
  "PLUGIN_GIT_UNAVAILABLE",
  "PLUGIN_GIT_FAILED",
  "PLUGIN_DOWNLOAD_FAILED",
  "PLUGIN_DOWNLOAD_TIMEOUT",
  "PLUGIN_DOWNLOAD_TOO_LARGE",
  "PLUGIN_ARCHIVE_INVALID",
  "PLUGIN_ARCHIVE_UNSAFE",
  "PLUGIN_ARCHIVE_TOO_LARGE",
  "PLUGIN_ARCHIVE_SHA256_MISMATCH",
  "PLUGIN_SOURCE_IS_MARKETPLACE",
  "PLUGIN_SOURCE_NOT_PLUGIN",
  "PLUGIN_SOURCE_UNSUPPORTED",
  "PLUGIN_SOURCE_PATH_MISSING",
  "PLUGIN_SOURCE_PATH_INVALID",
  "PLUGIN_NAME_MISMATCH",
  "PLUGIN_MARKETPLACE_REMOVED",
  "PLUGIN_ORIGIN_UNKNOWN",
  "PLUGIN_TYPESCRIPT_NO_COMPILER",
  "MARKETPLACE_CLAUDE_FORMAT",
  "MARKETPLACE_IS_PLUGIN",
  "MARKETPLACE_NOT_FOUND",
  "MARKETPLACE_INVALID",
  "MARKETPLACE_EXISTS",
  "MARKETPLACE_PATH_MISSING",
  "MARKETPLACE_FILE_NOT_JSON",
  "MARKETPLACE_SOURCE_UNSUPPORTED",
  "MARKETPLACE_ENTRY_UNSUPPORTED",
  "MARKETPLACE_RENAMED",
  "MARKETPLACE_DISABLED",
])

/** 把 Host 的错误换成界面语言的说明；不认识的错误原样显示。 */
export function pluginErrorText(error: unknown, t: (key: MessageKey) => string): string {
  const message = error instanceof Error ? error.message : String(error)
  const match = /([A-Z][A-Z0-9_]+): ?([\s\S]*)$/.exec(message)
  const code = match?.[1]
  if (!code || !ERROR_CODES.has(code)) return message
  return fill(t(`plugins.error.${code}` as MessageKey), { detail: (match?.[2] ?? "").trim() })
}

/** 类型的本地化文案，也是插件页里分组的标题。 */
export const kindKeys: Record<PluginKind, MessageKey> = {
  agent: "plugins.kind.agent",
  capability: "plugins.kind.capability",
  ui: "plugins.kind.ui",
  bundle: "plugins.kind.bundle",
}

/** 插件页里分组的先后。 */
export const KIND_ORDER: readonly PluginKind[] = ["agent", "capability", "ui", "bundle"]

/** 一次替换模板里的全部 {name}：替换进去的值原样显示，不会再被当成占位符或 $ 替换模式。 */
export function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? (values[name] ?? match) : match,
  )
}

/**
 * 插件的状态：加载失败 > 冲突 > 启用 > 停用。命令执行出错不算加载失败：插件照常在用，
 * 错误只在详情里列出来。
 */
export function statusOf(plugin: PluginSummary): { tone: StatusTone; label: MessageKey } {
  if (
    (plugin.error && plugin.error !== plugin.conflict) ||
    (plugin.clientErrors ?? []).some((error) => error.kind !== "command")
  ) {
    return { tone: "error", label: "plugins.status.failed" }
  }
  if (plugin.conflict || (plugin.contributionConflicts?.length ?? 0) > 0) {
    return { tone: "warning", label: "plugins.status.conflict" }
  }
  return plugin.enabled
    ? { tone: "ready", label: "plugins.enabled" }
    : { tone: "idle", label: "plugins.disabled" }
}

/**
 * 卡片和详情里的一句话说明：Agent 插件优先用 manifest 里按语言写的 agent 说明，
 * 其次是包的 description；都没有时为 null。
 */
export function descriptionOf(plugin: PluginSummary, locale: Locale): string | null {
  const agent = plugin.contributes.agent
  if (agent && typeof agent === "object" && "description" in agent) {
    const text = (agent as { description?: unknown }).description
    if (typeof text === "string" && text) return text
    if (text && typeof text === "object") {
      const localized = (text as Record<string, unknown>)[locale]
      if (typeof localized === "string" && localized) return localized
    }
  }
  return plugin.description || null
}
