/**
 * 已注册 agent 的目录：设置值的读写、只读检测、模型目录（含自定义模型）与默认 agent。
 * driver 每次检测、列模型、建会话都拿到最新的设置，改设置不需要重新加载插件。
 */
import type { Context } from "cordis"
import type { ProviderModel, ProviderStatus } from "@pigcode/contracts"
import {
  DEFAULT_PROVIDER_KEY,
  createDetectionCache,
  customModelIds,
  forcedAgentId,
  normalizeProviderSettings,
  pickDefaultProvider,
  providerSettingsKey,
  readProviderSettings,
} from "./agent-settings"
import type { ProviderDriver, ProviderSettingsValues } from "./driver"
import { createModelCatalogCache, normalizeModels, withCustomModels } from "./model-catalog"
import { listProviderModels } from "./switching"

/** detect 的选项：只检测一个 agent，或跳过缓存重新检测。 */
export interface DetectOptions {
  providerId?: string | undefined
  refresh?: boolean | undefined
}

/** agent 目录对 providers 服务暴露的能力。 */
export interface AgentCatalog {
  settingsFor(providerId: string): ProviderSettingsValues
  detect(options?: DetectOptions): Promise<Record<string, ProviderStatus>>
  models(providerId: string): Promise<ProviderModel[]>
  defaultProvider(): Promise<string | null>
  configuredDefault(): string | null
  setDefaultProvider(providerId: string | null): void
  updateSettings(providerId: string, values: Record<string, unknown>): ProviderSettingsValues
  /** driver 注册、注销或设置变化后丢掉缓存的检测与模型目录。 */
  invalidate(providerId?: string): void
}

/** 没实现 detect 的 driver 视为可用；未注册的 agent 明确报告找不到。 */
function fallbackStatus(driver: ProviderDriver | undefined, providerId: string): ProviderStatus {
  return driver
    ? { installed: true, version: null, authenticated: null }
    : {
        installed: false,
        version: null,
        authenticated: null,
        error: `provider not found: ${providerId}`,
      }
}

/** 创建 agent 目录；drivers 由 registry 维护，这里只读。 */
export function createAgentCatalog(
  ctx: Context,
  drivers: ReadonlyMap<string, ProviderDriver>,
): AgentCatalog {
  const catalogs = createModelCatalogCache()
  const detections = createDetectionCache()

  /** settings 服务是可选的：单元测试里没有它时所有 agent 都按默认值运行。 */
  const store = () => ctx.get("settings")
  const settingsFor = (providerId: string) => readProviderSettings(store(), providerId)

  function detectOne(providerId: string, refresh = false): Promise<ProviderStatus> {
    const driver = drivers.get(providerId)
    if (!driver?.detect) return Promise.resolve(fallbackStatus(driver, providerId))
    const detect = driver.detect.bind(driver)
    return detections.get(providerId, () => detect(settingsFor(providerId)), refresh)
  }

  function requireStore() {
    const settings = store()
    if (!settings) throw new Error("settings service unavailable")
    return settings
  }

  return {
    settingsFor,
    async detect(options = {}) {
      const ids = options.providerId ? [options.providerId] : [...drivers.keys()]
      const entries = await Promise.all(
        ids.map(async (id) => [id, await detectOne(id, options.refresh)] as const),
      )
      return Object.fromEntries(entries)
    },
    async models(providerId) {
      const driver = drivers.get(providerId)
      const settings = settingsFor(providerId)
      // 只缓存 agent 自己的目录；自定义模型每次现取，改完设置立刻出现在选择器里。
      const models = await catalogs.get(providerId, async () =>
        normalizeModels(await listProviderModels(driver, settings)),
      )
      return withCustomModels(models, customModelIds(settings))
    },
    defaultProvider() {
      const configured = store()?.get(DEFAULT_PROVIDER_KEY)
      return pickDefaultProvider({
        registered: [...drivers.keys()],
        forced: forcedAgentId(),
        configured: typeof configured === "string" ? configured : undefined,
        status: (id) => detectOne(id),
      })
    },
    configuredDefault() {
      const configured = store()?.get(DEFAULT_PROVIDER_KEY)
      return typeof configured === "string" ? configured : null
    },
    setDefaultProvider(providerId) {
      requireStore().set(DEFAULT_PROVIDER_KEY, providerId ?? undefined)
    },
    updateSettings(providerId, values) {
      const normalized = normalizeProviderSettings(values)
      const key = providerSettingsKey(providerId)
      requireStore().set(key, Object.keys(normalized).length > 0 ? normalized : undefined)
      catalogs.invalidate(providerId)
      detections.invalidate(providerId)
      return normalized
    },
    invalidate(providerId) {
      catalogs.invalidate(providerId)
      detections.invalidate(providerId)
    },
  }
}
