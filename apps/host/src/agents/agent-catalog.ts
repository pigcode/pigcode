/**
 * 已注册 agent 的目录：设置值的读写、只读检测、模型目录（含自定义模型）与默认 agent。
 * driver 每次检测、列模型、建会话都拿到最新的设置，改设置不需要重新加载插件。
 */
import type { Context } from "cordis"
import type { AgentModel, AgentStatus } from "@pigcode/contracts"
import {
  DEFAULT_AGENT_KEY,
  createDetectionCache,
  customModelIds,
  forcedAgentId,
  normalizeAgentSettings,
  pickDefaultAgent,
  agentSettingsKey,
  readAgentSettings,
} from "./agent-settings"
import type { AgentDriver, AgentSettingsValues } from "./driver"
import { createModelCatalogCache, normalizeModels, withCustomModels } from "./model-catalog"
import { listAgentModels } from "./switching"

/** detect 的选项：只检测一个 agent，或跳过缓存重新检测。 */
export interface DetectOptions {
  agentId?: string | undefined
  refresh?: boolean | undefined
}

/** agent 目录对 agents 服务暴露的方法。 */
export interface AgentCatalog {
  settingsFor(agentId: string): AgentSettingsValues
  detect(options?: DetectOptions): Promise<Record<string, AgentStatus>>
  models(agentId: string): Promise<AgentModel[]>
  defaultAgent(): Promise<string | null>
  configuredDefault(): string | null
  setDefaultAgent(agentId: string | null): void
  updateSettings(agentId: string, values: Record<string, unknown>): AgentSettingsValues
  /** driver 注册、注销或设置变化后丢掉缓存的检测与模型目录。 */
  invalidate(agentId?: string): void
}

/** 没实现 detect 的 driver 视为可用；未注册的 agent 明确报告找不到。 */
function fallbackStatus(driver: AgentDriver | undefined, agentId: string): AgentStatus {
  return driver
    ? { installed: true, version: null, authenticated: null }
    : {
        installed: false,
        version: null,
        authenticated: null,
        error: `agent not found: ${agentId}`,
      }
}

/** 创建 agent 目录；drivers 由 registry 维护，这里只读。 */
export function createAgentCatalog(
  ctx: Context,
  drivers: ReadonlyMap<string, AgentDriver>,
): AgentCatalog {
  const catalogs = createModelCatalogCache()
  const detections = createDetectionCache()

  /** settings 服务是可选的：单元测试里没有它时所有 agent 都按默认值运行。 */
  const store = () => ctx.get("settings")
  const settingsFor = (agentId: string) => readAgentSettings(store(), agentId)

  function detectOne(agentId: string, refresh = false): Promise<AgentStatus> {
    const driver = drivers.get(agentId)
    if (!driver?.detect) return Promise.resolve(fallbackStatus(driver, agentId))
    const detect = driver.detect.bind(driver)
    return detections.get(agentId, () => detect(settingsFor(agentId)), refresh)
  }

  function requireStore() {
    const settings = store()
    if (!settings) throw new Error("settings service unavailable")
    return settings
  }

  return {
    settingsFor,
    async detect(options = {}) {
      const ids = options.agentId ? [options.agentId] : [...drivers.keys()]
      const entries = await Promise.all(
        ids.map(async (id) => [id, await detectOne(id, options.refresh)] as const),
      )
      return Object.fromEntries(entries)
    },
    async models(agentId) {
      const driver = drivers.get(agentId)
      const settings = settingsFor(agentId)
      // 只缓存 agent 自己的目录；自定义模型每次现取，改完设置立刻出现在选择器里。
      const models = await catalogs.get(agentId, async () =>
        normalizeModels(await listAgentModels(driver, settings)),
      )
      return withCustomModels(models, customModelIds(settings))
    },
    defaultAgent() {
      const configured = store()?.get(DEFAULT_AGENT_KEY)
      return pickDefaultAgent({
        registered: [...drivers.keys()],
        forced: forcedAgentId(),
        configured: typeof configured === "string" ? configured : undefined,
        status: (id) => detectOne(id),
      })
    },
    configuredDefault() {
      const configured = store()?.get(DEFAULT_AGENT_KEY)
      return typeof configured === "string" ? configured : null
    },
    setDefaultAgent(agentId) {
      requireStore().set(DEFAULT_AGENT_KEY, agentId ?? undefined)
    },
    updateSettings(agentId, values) {
      const normalized = normalizeAgentSettings(values)
      const key = agentSettingsKey(agentId)
      requireStore().set(key, Object.keys(normalized).length > 0 ? normalized : undefined)
      catalogs.invalidate(agentId)
      detections.invalidate(agentId)
      return normalized
    },
    invalidate(agentId) {
      catalogs.invalidate(agentId)
      detections.invalidate(agentId)
    },
  }
}
