/**
 * 设置页的 agent 列表与设置校验：把 provider 插件的 manifest、已注册的 driver 与保存的值合在一起。
 * agent 来自 provider 插件（内置或用户安装）；没有插件的 driver（开发用的 fake）也会列出。
 */
import type { Context } from "cordis"
import {
  CUSTOM_MODELS_KEY,
  customModelsSchema,
  environmentEntriesSchema,
  type AgentList,
  type AgentSummary,
  type ProviderSettingField,
} from "@pigcode/contracts"
import { readProviderContribution } from "@pigcode/plugin-sdk"

/** 列出全部 agent；插件服务不在时只列已注册的 driver。 */
export async function listAgents(ctx: Context): Promise<AgentList> {
  const registered = new Map(ctx.providers.list().map((driver) => [driver.id, driver]))
  const plugins = ctx.get("plugins")
  const [records, summaries] = plugins
    ? await Promise.all([plugins.records(), plugins.list()])
    : [[], []]
  const errors = new Map(summaries.map((summary) => [summary.id, summary.error]))
  const agents: AgentSummary[] = []
  const listed = new Set<string>()
  for (const record of records) {
    const manifest = record.manifest
    if (manifest?.pigcode.kind !== "provider") continue
    const contribution = readProviderContribution(manifest)
    if (!contribution || listed.has(contribution.id)) continue
    listed.add(contribution.id)
    const driver = registered.get(contribution.id)
    agents.push({
      providerId: contribution.id,
      displayName: driver?.displayName ?? manifest.pigcode.displayName ?? manifest.name,
      pluginId: record.id,
      version: manifest.version,
      builtin: record.builtin,
      enabled: !record.disabled,
      registered: driver !== undefined,
      capabilities: driver?.capabilities ?? null,
      description: contribution.description ?? manifest.description ?? null,
      homepage: contribution.homepage ?? null,
      installHint: contribution.installHint ?? null,
      fields: contribution.settings,
      customModels: contribution.customModels,
      values: ctx.providers.getSettings(contribution.id),
      error: errors.get(record.id) ?? null,
    })
  }
  for (const driver of registered.values()) {
    if (listed.has(driver.id)) continue
    agents.push({
      providerId: driver.id,
      displayName: driver.displayName,
      pluginId: null,
      version: null,
      builtin: true,
      enabled: true,
      registered: true,
      capabilities: driver.capabilities,
      description: null,
      homepage: null,
      installHint: null,
      fields: [],
      customModels: true,
      values: ctx.providers.getSettings(driver.id),
      error: null,
    })
  }
  return { agents, defaultProviderId: ctx.providers.configuredDefaultProvider() }
}

/**
 * 卸载插件；它提供的 agent 是默认 agent 时把默认改回自动。停用是暂时的，默认选择保留，
 * 重新启用后照旧生效；卸载以后这个选择就没有对象了。
 */
export async function uninstallPluginAndClearDefault(ctx: Context, id: string): Promise<void> {
  const record = (await ctx.plugins.records()).find((item) => item.id === id)
  await ctx.plugins.uninstall(id)
  const manifest = record?.manifest
  const providerId =
    manifest?.pigcode.kind === "provider" ? readProviderContribution(manifest)?.id : undefined
  if (providerId && ctx.providers.configuredDefaultProvider() === providerId) {
    ctx.providers.setDefaultProvider(null)
  }
}

/** 一个设置值是否符合字段声明的类型；留空（null、空字符串、空数组）总是允许。 */
function matchesField(field: ProviderSettingField, value: unknown): boolean {
  if (value === null || value === "") return true
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean"
    case "env":
      return environmentEntriesSchema.safeParse(value).success
    case "select":
      return typeof value === "string" && field.options.some((option) => option.value === value)
    default:
      return typeof value === "string"
  }
}

/**
 * 校验要保存的设置：只接受 agent 声明过的字段与 customModels，类型不对时抛出可读的错误，
 * 避免把界面或脚本传来的杂项写进 settings.json。
 */
export function validateAgentSettings(
  agent: Pick<AgentSummary, "providerId" | "fields" | "customModels">,
  values: Record<string, unknown>,
): void {
  const fields = new Map(agent.fields.map((field) => [field.key, field]))
  for (const [key, value] of Object.entries(values)) {
    if (key === CUSTOM_MODELS_KEY) {
      if (!agent.customModels && Array.isArray(value) && value.length > 0) {
        throw new Error(`${agent.providerId} does not accept custom models`)
      }
      if (value !== null && !customModelsSchema.safeParse(value).success) {
        throw new Error("customModels must be a list of model ids")
      }
      continue
    }
    const field = fields.get(key)
    if (!field) throw new Error(`unknown setting for ${agent.providerId}: ${key}`)
    if (!matchesField(field, value)) throw new Error(`invalid value for ${agent.providerId}.${key}`)
  }
}
