/**
 * 已注册 agent 的目录：设置值的读写、只读检测、模型目录（含自定义模型）、实例与默认 agent。
 * driver 每次检测、列模型、建会话都拿到最新的设置，改设置不需要重新加载插件。
 *
 * 一个 Agent 可以有多份互相独立的配置（实例）。默认实例的值仍存在 `agents.<agentId>`，
 * 用户新建的实例存在 `agentInstances`；线程、会话与检测结果都按 instanceId 区分。
 */
import type { Context } from "cordis"
import type { AgentCommand, AgentInstance, AgentModel, AgentStatus } from "@pigcode/contracts"
import {
  DEFAULT_AGENT_KEY,
  DEFAULT_INSTANCE_KEY,
  createDetectionCache,
  createInstance as createStoredInstance,
  customModelIds,
  forcedAgentId,
  listInstances as listStoredInstances,
  normalizeAgentSettings,
  pickDefaultAgent,
  agentSettingsKey,
  readDefaultInstanceId,
  readStoredInstances,
  removeInstance as removeStoredInstance,
  resolveInstance,
  updateInstance as updateStoredInstance,
  type ResolvedInstance,
} from "./agent-settings"
import type { AgentDriver, AgentSettingsValues } from "./driver"
import {
  createModelCatalogCache,
  normalizeCommands,
  normalizeModels,
  withCustomModels,
} from "./model-catalog"
import { listAgentModels } from "./switching"

/** detect 的选项：只检测一个 agent 或实例，或跳过缓存重新检测。 */
export interface DetectOptions {
  agentId?: string | undefined
  instanceId?: string | undefined
  refresh?: boolean | undefined
}

/** 新会话默认使用的 agent 与实例；没有可用的 agent 时都是 null。 */
export interface DefaultAgentChoice {
  agentId: string | null
  instanceId: string | null
}

/** agent 目录对 agents 服务暴露的方法。 */
export interface AgentCatalog {
  /** 默认实例的设置；旧的调用方式，等价于 settingsForInstance(agentId, agentId)。 */
  settingsFor(agentId: string): AgentSettingsValues
  /** 指定实例的设置；实例不存在或不属于这个 agent 时退回默认实例。 */
  settingsForInstance(agentId: string, instanceId?: string | null): AgentSettingsValues
  /** 解析实例（含默认实例），供切换、run 启动与设置页使用。 */
  instance(agentId: string, instanceId?: string | null): ResolvedInstance
  detect(options?: DetectOptions): Promise<Record<string, AgentStatus>>
  models(agentId: string, instanceId?: string | null): Promise<AgentModel[]>
  /** 实例在 cwd 下的 `/` 命令；按实例与工作目录缓存。 */
  commands(agentId: string, instanceId: string | null, cwd: string | null): Promise<AgentCommand[]>
  defaultAgent(): Promise<DefaultAgentChoice>
  configuredDefault(): string | null
  configuredDefaultInstance(): string | null
  setDefaultAgent(agentId: string | null, instanceId?: string | null): void
  updateSettings(
    agentId: string,
    values: Record<string, unknown>,
    instanceId?: string | null,
  ): AgentSettingsValues
  /** 一个 agent 的全部实例，默认实例在前、名字用 agent 的显示名。 */
  instances(agentId: string): AgentInstance[]
  /** 某个实例；找不到时返回 null。 */
  findInstance(instanceId: string): AgentInstance | null
  createInstance(agentId: string, label: string, copyFrom?: string | null): AgentInstance
  updateInstance(
    instanceId: string,
    patch: {
      label?: string | undefined
      enabled?: boolean | undefined
      values?: Record<string, unknown> | undefined
    },
  ): AgentInstance
  /** 删除实例并返回它；默认实例不能删。 */
  removeInstance(instanceId: string): AgentInstance | null
  /** driver 注册、注销或设置变化后丢掉缓存的检测与模型目录。 */
  invalidate(instanceId?: string): void
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
  const commandCatalogs = createModelCatalogCache<AgentCommand>()
  const detections = createDetectionCache()

  /** settings 服务是可选的：单元测试里没有它时所有 agent 都按默认值运行。 */
  const store = () => ctx.get("settings")
  const instanceFor = (agentId: string, instanceId?: string | null): ResolvedInstance =>
    resolveInstance(store(), agentId, instanceId)
  const settingsFor = (agentId: string) => instanceFor(agentId).values

  /** 检测一个实例：把它的设置交给 driver，结果按实例缓存。 */
  function detectOne(agentId: string, instanceId: string, refresh = false): Promise<AgentStatus> {
    const driver = drivers.get(agentId)
    if (!driver?.detect) return Promise.resolve(fallbackStatus(driver, agentId))
    const detect = driver.detect.bind(driver)
    const values = instanceFor(agentId, instanceId).values
    return detections.get(instanceId, () => detect(values), refresh)
  }

  function requireStore() {
    const settings = store()
    if (!settings) throw new Error("settings service unavailable")
    return settings
  }

  return {
    settingsFor,
    settingsForInstance(agentId, instanceId) {
      return instanceFor(agentId, instanceId).values
    },
    instance: instanceFor,
    async detect(options = {}) {
      // 只检测一个实例、一个 agent 的全部实例，或全部 agent 的全部实例。
      const targets: Array<[string, string]> = []
      if (options.instanceId) {
        const instance = findInstanceWith(options.instanceId)
        if (!instance) return {}
        targets.push([instance.agentId, instance.instanceId])
      } else {
        const ids = options.agentId ? [options.agentId] : [...drivers.keys()]
        for (const id of ids) {
          for (const instance of listInstancesOf(id)) targets.push([id, instance.instanceId])
        }
      }
      const entries = await Promise.all(
        targets.map(
          async ([agentId, instanceId]) =>
            [instanceId, await detectOne(agentId, instanceId, options.refresh)] as const,
        ),
      )
      return Object.fromEntries(entries)
    },
    async models(agentId, instanceId) {
      const driver = drivers.get(agentId)
      const instance = instanceFor(agentId, instanceId)
      const settings = instance.values
      // 只缓存 agent 自己的目录；自定义模型每次现取，改完设置立刻出现在选择器里。
      const models = await catalogs.get(instance.instanceId, async () =>
        normalizeModels(await listAgentModels(driver, settings)),
      )
      return withCustomModels(models, customModelIds(settings))
    },
    async commands(agentId, instanceId, cwd) {
      const driver = drivers.get(agentId)
      const instance = instanceFor(agentId, instanceId)
      if (!driver?.listCommands) return []
      const list = driver.listCommands.bind(driver)
      return commandCatalogs.get(`${instance.instanceId}\0${cwd ?? ""}`, async () =>
        normalizeCommands(await list(instance.values, cwd).catch(() => [])),
      )
    },
    async defaultAgent() {
      const configured = store()?.get(DEFAULT_AGENT_KEY)
      const agentId = await pickDefaultAgent({
        registered: [...drivers.keys()],
        forced: forcedAgentId(),
        configured: typeof configured === "string" ? configured : undefined,
        status: (id) => detectOne(id, id),
      })
      if (!agentId) return { agentId: null, instanceId: null }
      const chosen = readDefaultInstanceId(store())
      // 选好的默认实例必须属于这个 agent 且还在；否则用默认实例。
      const instance = chosen ? findInstanceWith(chosen) : null
      return {
        agentId,
        instanceId:
          instance && instance.agentId === agentId && instance.enabled
            ? instance.instanceId
            : agentId,
      }
    },
    configuredDefault() {
      const configured = store()?.get(DEFAULT_AGENT_KEY)
      return typeof configured === "string" ? configured : null
    },
    configuredDefaultInstance() {
      return readDefaultInstanceId(store())
    },
    setDefaultAgent(agentId, instanceId) {
      const settings = requireStore()
      settings.set(DEFAULT_AGENT_KEY, agentId ?? undefined)
      // 默认实例不用单独记：没有 defaultInstance 就是 agent 自己的默认配置。
      settings.set(
        DEFAULT_INSTANCE_KEY,
        agentId && instanceId && instanceId !== agentId ? instanceId : undefined,
      )
    },
    updateSettings(agentId, values, instanceId) {
      const normalized = normalizeAgentSettings(values)
      const settings = requireStore()
      if (instanceId && instanceId !== agentId) {
        updateStoredInstance(settings, instanceId, { values: normalized })
      } else {
        settings.set(
          agentSettingsKey(agentId),
          Object.keys(normalized).length > 0 ? normalized : undefined,
        )
      }
      catalogs.invalidate(instanceId ?? agentId)
      commandCatalogs.invalidate(instanceId ?? agentId)
      detections.invalidate(instanceId ?? agentId)
      return normalized
    },
    instances(agentId) {
      const displayName = drivers.get(agentId)?.displayName ?? agentId
      return listStoredInstances(store(), agentId, displayName)
    },
    findInstance(instanceId) {
      return findInstanceWith(instanceId)
    },
    createInstance(agentId, label, copyFrom) {
      const created = createStoredInstance(requireStore(), agentId, label, copyFrom)
      detections.invalidate(created.instanceId)
      catalogs.invalidate(created.instanceId)
      commandCatalogs.invalidate(created.instanceId)
      return created
    },
    updateInstance(instanceId, patch) {
      const updated = updateStoredInstance(requireStore(), instanceId, patch)
      detections.invalidate(instanceId)
      catalogs.invalidate(instanceId)
      commandCatalogs.invalidate(instanceId)
      return updated
    },
    removeInstance(instanceId) {
      const settings = requireStore()
      const instance = findInstanceWith(instanceId)
      removeStoredInstance(settings, instanceId)
      if (readDefaultInstanceId(settings) === instanceId)
        settings.set(DEFAULT_INSTANCE_KEY, undefined)
      detections.invalidate(instanceId)
      catalogs.invalidate(instanceId)
      commandCatalogs.invalidate(instanceId)
      return instance
    },
    invalidate(instanceId) {
      catalogs.invalidate(instanceId)
      commandCatalogs.invalidate(instanceId)
      detections.invalidate(instanceId)
    },
  }

  /** 一个 agent 的实例；agent 不在已注册列表里时也按默认实例返回一份。 */
  function listInstancesOf(agentId: string): ResolvedInstance[] {
    const displayName = drivers.get(agentId)?.displayName ?? agentId
    return listStoredInstances(store(), agentId, displayName)
  }

  /** 按 instanceId 找实例：默认实例的 id 就是某个已注册 agent 的 id。 */
  function findInstanceWith(instanceId: string): ResolvedInstance | null {
    const stored = readStoredInstances(store())[instanceId]
    if (stored) return instanceFor(stored.agentId, instanceId)
    if (drivers.has(instanceId)) return instanceFor(instanceId)
    return null
  }
}
