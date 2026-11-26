/**
 * 手机端插件与插件市场管理处理器：
 * - 脱敏本机绝对路径、原始 contributes 与 data: 内联大图标；
 * - 仅开放列表/启停/更新/卸载/已启用市场刷新与市场安装，严禁暴露任意源安装与市场源增删；
 * - 列表与市场均严格裁剪在 48 KiB UTF-8 JSON 预算内，满足单帧 Noise 加密上限。
 */
import type { Context } from "cordis"
import {
  MOBILE_MARKETPLACE_ICON_MAX_LENGTH,
  mobilePluginIdParamsSchema,
  mobilePluginInstallFromMarketplaceParamsSchema,
  mobilePluginListParamsSchema,
  mobilePluginListResultSchema,
  mobilePluginMarketplacesParamsSchema,
  mobilePluginMarketplacesResultSchema,
  mobilePluginMethods,
  mobilePluginMutationResultSchema,
  mobilePluginRefreshMarketplacesParamsSchema,
  mobilePluginSetEnabledParamsSchema,
  mobilePluginUninstallResultSchema,
  type MobileMarketplacePlugin,
  type MobileMarketplaceSummary,
  type MobilePluginOriginKind,
  type MobilePluginSummary,
  type RpcRequest,
} from "@pigcode/contracts"
import { uninstallPluginAndClearDefault } from "../rpc/agents"
import { PluginConflictError, type PluginSummary } from "../services/plugin-manager"
import type { MarketplaceEntry, MarketplaceSummary } from "../services/plugin-marketplace"
import type { PluginsService } from "../services/plugins"
import { mobileErrorMessages, mobileParams as params, MobileRequestError } from "./request-error"

export const mobilePluginRequests = new Set<string>(Object.values(mobilePluginMethods))

const PLUGIN_JSON_BUDGET_BYTES = 48 * 1024
const ORIGIN_LABEL_MAX_LENGTH = 256
const ERROR_TEXT_MAX_LENGTH = 512

function looksLikeLocalPath(value: string): boolean {
  return /^(?:[/\\~]|\.\.?\/|file:|[A-Za-z]:[\\/])/i.test(value)
}

/** 脱敏插件来源文案：本地目录或包含本机绝对路径的一律收敛为「本地目录」。 */
export function sanitizeOriginLabel(
  label: string | null | undefined,
  originKind?: MobilePluginOriginKind | null,
): string | null {
  if (originKind === "local") return "本地目录"
  const trimmed = label?.trim() ?? ""
  if (!trimmed) return null
  if (looksLikeLocalPath(trimmed)) return "本地目录"
  return trimmed.length > ORIGIN_LABEL_MAX_LENGTH
    ? `${trimmed.slice(0, ORIGIN_LABEL_MAX_LENGTH - 1)}…`
    : trimmed
}

/** 脱敏市场插件图标：仅保留长度 <= 512 的 https:// 地址，拒绝任何 data: 内联图。 */
export function sanitizeMarketplaceIcon(icon: string | null | undefined): string | null {
  const trimmed = icon?.trim() ?? ""
  if (!trimmed || trimmed.length > MOBILE_MARKETPLACE_ICON_MAX_LENGTH) return null
  if (!trimmed.startsWith("https://")) return null
  try {
    return new URL(trimmed).protocol === "https:" ? trimmed : null
  } catch {
    return null
  }
}

/** 脱敏市场来源文案：本地目录/文件市场绝不暴露本机路径。 */
export function sanitizeMarketplaceLabel(market: MarketplaceSummary): string {
  if (market.sourceType === "directory" || market.sourceType === "file") {
    return market.displayName.trim() || "本地市场"
  }
  return sanitizeOriginLabel(market.sourceLabel) ?? market.displayName
}

function truncateText(
  text: string | null | undefined,
  maxLen = ERROR_TEXT_MAX_LENGTH,
): string | null {
  const trimmed = text?.trim() ?? ""
  if (!trimmed) return null
  return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen - 1)}…` : trimmed
}

function stripAbsolutePaths(text: string): string {
  return text
    .replace(/file:\/\/\/[^\s"'`]+/gi, "<local>")
    .replace(/(?:^|[\s(:])(?:\/[\w.@+-]+){2,}/g, (match) => {
      const prefix = match.startsWith("/") ? "" : match[0]!
      return `${prefix}<local>`
    })
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, "<local>")
}

function conciseActionMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const firstLine = stripAbsolutePaths(raw.split(/\r?\n/, 1)[0] ?? "").trim()
  if (!firstLine) return mobileErrorMessages.PLUGIN_ACTION_FAILED
  const reason = firstLine.length > 160 ? `${firstLine.slice(0, 159)}…` : firstLine
  return `${mobileErrorMessages.PLUGIN_ACTION_FAILED} ${reason}`
}

function originKindOf(summary: PluginSummary): MobilePluginOriginKind | null {
  if (summary.builtin) return "builtin"
  if (!summary.origin) return null
  return summary.origin.kind === "archive" ? "url" : summary.origin.kind
}

function toMobilePlugin(summary: PluginSummary): MobilePluginSummary {
  const originKind = originKindOf(summary)
  const marketOrigin = summary.origin?.kind === "marketplace" ? summary.origin : null
  return {
    id: summary.id,
    name: summary.name,
    displayName: summary.displayName || summary.name,
    description: summary.description ?? null,
    version: summary.version,
    kind: summary.kind,
    enabled: summary.enabled,
    builtin: summary.builtin,
    apiVersion: summary.apiVersion,
    permissions: [...summary.permissions],
    provides: [...summary.provides],
    conflict: truncateText(summary.conflict),
    error: truncateText(summary.error),
    originKind,
    marketplaceId: marketOrigin?.marketplace ?? null,
    marketplacePluginName: marketOrigin?.plugin ?? null,
    originLabel: summary.builtin ? null : sanitizeOriginLabel(summary.originLabel, originKind),
    canUpdate: !summary.builtin && summary.origin !== null,
  }
}

function toMobileMarketplacePlugin(entry: MarketplaceEntry): MobileMarketplacePlugin {
  return {
    name: entry.name,
    displayName: entry.displayName ?? null,
    description: entry.description ?? null,
    version: entry.version ?? null,
    category: entry.category ?? null,
    iconUrl: sanitizeMarketplaceIcon(entry.icon),
    homepage: entry.homepage ?? null,
    author: entry.author ?? null,
    publisherType: entry.publisherType ?? null,
    ...(entry.displayName_i18n ? { displayNameI18n: entry.displayName_i18n } : {}),
    ...(entry.description_i18n ? { descriptionI18n: entry.description_i18n } : {}),
    sourceLabel: sanitizeOriginLabel(entry.sourceLabel) ?? "",
  }
}

function toMobileMarketplace(market: MarketplaceSummary): MobileMarketplaceSummary {
  return {
    id: market.id,
    official: market.official === true,
    displayName: market.displayName || market.id,
    description: market.description ?? null,
    owner: market.owner ?? null,
    sourceType: market.sourceType,
    sourceLabel: sanitizeMarketplaceLabel(market),
    sourceUrl: market.sourceUrl ?? null,
    enabled: market.enabled,
    lastUpdated: market.lastUpdated ?? null,
    error: truncateText(market.error ? stripAbsolutePaths(market.error) : null),
    plugins: market.plugins.map(toMobileMarketplacePlugin),
  }
}

function clipPluginsToBudget(items: readonly MobilePluginSummary[]) {
  const plugins: MobilePluginSummary[] = []
  let used = Buffer.byteLength('{"plugins":[],"truncated":true}', "utf8")
  let truncated = false
  for (const item of items) {
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8") + 1
    if (used + bytes > PLUGIN_JSON_BUDGET_BYTES) {
      truncated = true
      break
    }
    plugins.push(item)
    used += bytes
  }
  return { plugins, truncated }
}

function clipMarketplacesToBudget(items: readonly MobileMarketplaceSummary[]) {
  const marketplaces: MobileMarketplaceSummary[] = []
  let used = Buffer.byteLength('{"marketplaces":[],"truncated":true}', "utf8")
  let truncated = false
  for (const market of items) {
    const shellBytes = Buffer.byteLength(JSON.stringify({ ...market, plugins: [] }), "utf8") + 1
    if (used + shellBytes > PLUGIN_JSON_BUDGET_BYTES) {
      truncated = true
      break
    }
    used += shellBytes
    const acceptedPlugins: MobileMarketplacePlugin[] = []
    for (const plugin of market.plugins) {
      const bytes = Buffer.byteLength(JSON.stringify(plugin), "utf8") + 1
      if (used + bytes > PLUGIN_JSON_BUDGET_BYTES) {
        truncated = true
        break
      }
      acceptedPlugins.push(plugin)
      used += bytes
    }
    marketplaces.push({ ...market, plugins: acceptedPlugins })
    if (truncated) break
  }
  return { marketplaces, truncated }
}

function mapPluginError(error: unknown): never {
  if (error instanceof MobileRequestError) throw error
  if (error instanceof PluginConflictError) throw new MobileRequestError("PLUGIN_CONFLICT")
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === "PROVIDES_CONFLICT" || /PROVIDES_CONFLICT/i.test(message)) {
    throw new MobileRequestError("PLUGIN_CONFLICT")
  }
  if (/PLUGIN_BUILTIN/i.test(message)) throw new MobileRequestError("PLUGIN_BUILTIN_IMMUTABLE")
  if (
    /plugin not found/i.test(message) ||
    /MARKETPLACE_UNKNOWN|MARKETPLACE_ENTRY_UNKNOWN|MARKETPLACE_DISABLED/i.test(message)
  ) {
    throw new MobileRequestError("PLUGIN_NOT_FOUND")
  }
  throw new MobileRequestError("PLUGIN_ACTION_FAILED", conciseActionMessage(error))
}

export class MobilePluginManage {
  constructor(
    private readonly ctx: Context,
    private readonly requirePairedDevice: () => void,
  ) {}

  async dispatch(request: RpcRequest): Promise<unknown> {
    this.requirePairedDevice()
    const plugins = this.ctx.get("plugins")
    if (!plugins) throw new MobileRequestError("METHOD_NOT_AVAILABLE")

    switch (request.method) {
      case mobilePluginMethods.list:
        params(mobilePluginListParamsSchema, request.params)
        return mobilePluginListResultSchema.parse(
          clipPluginsToBudget((await plugins.list()).map(toMobilePlugin)),
        )
      case mobilePluginMethods.setEnabled: {
        const parsed = params(mobilePluginSetEnabledParamsSchema, request.params)
        return this.setEnabled(plugins, parsed.id, parsed.enabled)
      }
      case mobilePluginMethods.update:
        return this.update(plugins, params(mobilePluginIdParamsSchema, request.params).id)
      case mobilePluginMethods.uninstall:
        return this.uninstall(plugins, params(mobilePluginIdParamsSchema, request.params).id)
      case mobilePluginMethods.marketplaces:
        params(mobilePluginMarketplacesParamsSchema, request.params)
        return this.formatMarketplaces(await plugins.marketplaces())
      case mobilePluginMethods.refreshMarketplaces: {
        const parsed = params(mobilePluginRefreshMarketplacesParamsSchema, request.params)
        return this.refreshMarketplaces(plugins, parsed.id, parsed.ifStale)
      }
      case mobilePluginMethods.installFromMarketplace: {
        const parsed = params(mobilePluginInstallFromMarketplaceParamsSchema, request.params)
        return this.installFromMarketplace(plugins, parsed.marketplace, parsed.name)
      }
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private formatMarketplaces(raw: readonly MarketplaceSummary[]) {
    const enabled = raw.filter((market) => market.enabled).map(toMobileMarketplace)
    return mobilePluginMarketplacesResultSchema.parse(clipMarketplacesToBudget(enabled))
  }

  private async requirePlugin(plugins: PluginsService, id: string): Promise<PluginSummary> {
    const found = (await plugins.list()).find((item) => item.id === id)
    if (!found) throw new MobileRequestError("PLUGIN_NOT_FOUND")
    return found
  }

  private async setEnabled(plugins: PluginsService, id: string, enabled: boolean) {
    await this.requirePlugin(plugins, id)
    try {
      await (enabled ? plugins.enable(id) : plugins.disable(id))
    } catch (error) {
      mapPluginError(error)
    }
    return mobilePluginMutationResultSchema.parse({
      plugin: toMobilePlugin(await this.requirePlugin(plugins, id)),
    })
  }

  private async update(plugins: PluginsService, id: string) {
    const existing = await this.requirePlugin(plugins, id)
    if (existing.builtin) throw new MobileRequestError("PLUGIN_BUILTIN_IMMUTABLE")
    try {
      await plugins.update(id)
    } catch (error) {
      mapPluginError(error)
    }
    return mobilePluginMutationResultSchema.parse({
      plugin: toMobilePlugin(await this.requirePlugin(plugins, id)),
    })
  }

  private async uninstall(plugins: PluginsService, id: string) {
    const existing = await this.requirePlugin(plugins, id)
    if (existing.builtin) throw new MobileRequestError("PLUGIN_BUILTIN_IMMUTABLE")
    try {
      await uninstallPluginAndClearDefault(this.ctx, id)
    } catch (error) {
      mapPluginError(error)
    }
    return mobilePluginUninstallResultSchema.parse({ uninstalled: true })
  }

  private async refreshMarketplaces(
    plugins: PluginsService,
    id: string | undefined,
    ifStale: boolean | undefined,
  ) {
    try {
      return this.formatMarketplaces(await plugins.refreshMarketplaces(id, ifStale))
    } catch (error) {
      mapPluginError(error)
    }
  }

  private async installFromMarketplace(plugins: PluginsService, marketplace: string, name: string) {
    const targetMarket = (await plugins.marketplaces()).find(
      (market) => market.id === marketplace && market.enabled,
    )
    if (!targetMarket) throw new MobileRequestError("PLUGIN_NOT_FOUND")
    try {
      const installed = await plugins.installFromMarketplace(marketplace, name)
      const latest = await plugins.list()
      const found =
        latest.find((item) => item.id === installed.id) ?? latest.find((item) => item.name === name)
      if (!found) throw new MobileRequestError("PLUGIN_NOT_FOUND")
      return mobilePluginMutationResultSchema.parse({ plugin: toMobilePlugin(found) })
    } catch (error) {
      mapPluginError(error)
    }
  }
}
