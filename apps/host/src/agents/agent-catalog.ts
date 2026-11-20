/**
 * 已注册 agent 的目录：设置值的读写、只读检测、模型目录（含自定义模型）、实例与默认 agent。
 * driver 每次检测、列模型、建会话都拿到最新的设置，改设置不需要重新加载插件。
 *
 * 一个 Agent 可以有多份互相独立的配置（实例）。默认实例的值仍存在 `agents.<agentId>`，
 * 用户新建的实例存在 `agentInstances`；线程、会话与检测结果都按 instanceId 区分。
 */
import type { Context } from "cordis"
import { createHash } from "node:crypto"
import { join } from "node:path"
import type {
  AcpRegistryEntry,
  AgentCommand,
  AgentInstance,
  AgentModel,
  AgentStatus,
} from "@pigcode/contracts"
import { readIdlePolicy } from "@pigcode/contracts"
import { isAgentPlugin, readAgentContribution } from "@pigcode/plugin-sdk"
import {
  DEFAULT_AGENT_KEY,
  DEFAULT_INSTANCE_KEY,
  createDetectionCache,
  createInstance as createStoredInstance,
  defaultInstanceEnabledKey,
  forcedAgentId,
  listInstances as listStoredInstances,
  modelPreferences,
  normalizeAgentSettings,
  pickDefaultAgent,
  agentSettingsKey,
  readDefaultInstanceId,
  readStoredInstances,
  removeInstance as removeStoredInstance,
  resolveInstance,
  updateInstance as updateStoredInstance,
  type InstanceCreateOptions,
  type ResolvedInstance,
} from "./agent-settings"
import type { AgentDriver, AgentInstanceContext, AgentSettingsValues } from "./driver"
import { AgentInstanceIdTakenError } from "./errors"
import {
  applyModelPreferences,
  createModelCatalogCache,
  normalizeCommands,
  normalizeModels,
} from "./model-catalog"
import { AgentSecrets, publicValues } from "./agent-secrets"
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
  acpRegistry(): Promise<AcpRegistryEntry[]>
  prepareAcpRegistry(registryId: string): Promise<AcpRegistryEntry>
  activateAcpRegistry(registryId: string, version: string): Promise<void>
  runtimeSettings(agentId: string, instanceId?: string | null): Promise<AgentSettingsValues>
  /** 默认实例的设置；旧的调用方式，等价于 settingsForInstance(agentId, agentId)。 */
  settingsFor(agentId: string): AgentSettingsValues
  /** 指定实例的设置；实例不存在或不属于这个 agent 时退回默认实例。 */
  settingsForInstance(agentId: string, instanceId?: string | null): AgentSettingsValues
  /** 解析实例（含默认实例），供切换、run 启动与设置页使用。 */
  instance(agentId: string, instanceId?: string | null): ResolvedInstance
  instanceContext(instance: AgentInstance): AgentInstanceContext | undefined
  detect(options?: DetectOptions): Promise<Record<string, AgentStatus>>
  models(agentId: string, instanceId?: string | null): Promise<AgentModel[]>
  /** 实例在 cwd 下的命令和 Skill，按实例与工作目录缓存。 */
  commands(
    agentId: string,
    instanceId: string | null,
    cwd: string | null,
    refresh?: boolean,
  ): Promise<AgentCommand[]>
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
  createInstance(agentId: string, label: string, options?: InstanceCreateOptions): AgentInstance
  updateInstance(
    instanceId: string,
    patch: {
      accentColor?: string | null | undefined
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
  dataDir?: string,
): AgentCatalog {
  const catalogs = createModelCatalogCache()
  const commandCatalogs = createModelCatalogCache<AgentCommand>()
  const detections = createDetectionCache()

  function invalidate(instanceId?: string) {
    catalogs.invalidate(instanceId)
    commandCatalogs.invalidate(instanceId)
    detections.invalidate(instanceId)
  }

  function agentDirectory(agentId: string) {
    return dataDir && join(dataDir, createHash("sha256").update(agentId).digest("hex"))
  }

  function instanceContext(instance: AgentInstance): AgentInstanceContext | undefined {
    const sharedDir = agentDirectory(instance.agentId)
    if (!sharedDir) return undefined
    const stored = instance.isDefault
      ? undefined
      : readStoredInstances(store())[instance.instanceId]
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          instance.agentId,
          instance.instanceId,
          stored?.storageKey ?? instance.createdAt,
        ]),
      )
      .digest("hex")
    const terminal = ctx.get("terminal")
    return {
      instanceId: instance.instanceId,
      sharedDir,
      dataDir: join(sharedDir, "instances", key),
      invalidate: () => invalidate(instance.instanceId),
      ...(terminal ? { openLoginTerminal: terminal.openLoginTerminal } : {}),
    }
  }

  /** settings 服务是可选的：单元测试里没有它时所有 agent 都按默认值运行。 */
  const store = () => ctx.get("settings")
  const instanceFor = (agentId: string, instanceId?: string | null): ResolvedInstance =>
    resolveInstance(store(), agentId, instanceId)
  const settingsDir = store()?.directory
  const secrets = new AgentSecrets(
    dataDir ?? (settingsDir ? join(settingsDir, "agents") : undefined),
    () => store()?.snapshot(),
  )
  const exposed = (instance: ResolvedInstance): ResolvedInstance => ({
    ...instance,
    values: publicValues(instance.values),
  })
  function runtimeInstance(agentId: string, instanceId?: string | null): ResolvedInstance {
    const instance = instanceFor(agentId, instanceId)
    const driver = drivers.get(agentId)
    if (!instance.isDefault || (!driver?.requiresInstance && !driver?.acpRegistry)) return instance
    if (!instanceId || instanceId === agentId) {
      const choices = listStoredInstances(store(), agentId, driver.displayName).filter(
        (item) => !item.isDefault && item.enabled,
      )
      const selected =
        choices.find((item) => item.instanceId === readDefaultInstanceId(store())) ?? choices[0]
      if (selected) return selected
    }
    throw new Error(`Choose a configured instance of ${driver.displayName}`)
  }
  async function runtimeSettings(agentId: string, instanceId?: string | null) {
    const values = await secrets.resolve(runtimeInstance(agentId, instanceId).values)
    if (agentId === "claude" && (!values.idleCompaction || values.idleCompaction === "default"))
      return { ...values, idleCompaction: readIdlePolicy(store()?.get("claude.idleCompaction")) }
    return values
  }
  const settingsFor = (agentId: string) => publicValues(instanceFor(agentId).values)

  /** 检测一个实例：把它的设置交给 driver，结果按实例缓存。 */
  function detectOne(agentId: string, instanceId: string, refresh = false): Promise<AgentStatus> {
    const driver = drivers.get(agentId)
    if (!driver?.detect) return Promise.resolve(fallbackStatus(driver, agentId))
    const detect = driver.detect.bind(driver)
    const execution =
      driver.accountSetup || driver.requiresInstance
        ? instanceContext(instanceFor(agentId, instanceId))
        : undefined
    return detections.get(
      instanceId,
      async () => {
        try {
          const values = await runtimeSettings(agentId, instanceId)
          return await (execution ? detect(values, execution) : detect(values))
        } catch (cause) {
          return {
            installed: false,
            version: null,
            authenticated: null,
            error: cause instanceof Error ? cause.message : String(cause),
          }
        }
      },
      refresh,
    )
  }

  function requireStore() {
    const settings = store()
    if (!settings) throw new Error("settings service unavailable")
    return settings
  }

  return {
    async prepareAcpRegistry(registryId) {
      const driver = drivers.get("acp")
      const dir = agentDirectory("acp")
      if (!driver?.prepareAcpRegistry || !dir) throw new Error("ACP Registry is unavailable")
      return driver.prepareAcpRegistry(registryId, dir)
    },
    async activateAcpRegistry(registryId, version) {
      const driver = drivers.get("acp")
      const dir = agentDirectory("acp")
      if (!driver?.activateAcpRegistry || !dir) throw new Error("ACP Registry is unavailable")
      await driver.activateAcpRegistry(registryId, version, dir)
      invalidate()
    },
    async acpRegistry() {
      const entries = await drivers.get("acp")?.acpRegistry?.()
      if (!entries?.length) return []
      const records = (await ctx.get("plugins")?.records()) ?? []
      const dedicated = new Set(
        records.flatMap(({ manifest, builtin, disabled }) => {
          if (!manifest || !isAgentPlugin(manifest)) return []
          const agent = readAgentContribution(manifest)
          if (!agent || (!builtin && (disabled || !drivers.has(agent.id)))) return []
          return agent.acpRegistryAgentIds ?? []
        }),
      )
      return entries.filter(({ id }) => !dedicated.has(id))
    },
    runtimeSettings,
    settingsFor,
    settingsForInstance(agentId, instanceId) {
      return publicValues(instanceFor(agentId, instanceId).values)
    },
    instance: runtimeInstance,
    instanceContext,
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
        targets.map(async ([agentId, instanceId]) => {
          if (options.refresh) {
            catalogs.invalidate(instanceId)
            commandCatalogs.invalidate(instanceId)
          }
          return [instanceId, await detectOne(agentId, instanceId, options.refresh)] as const
        }),
      )
      return Object.fromEntries(entries)
    },
    async models(agentId, instanceId) {
      const driver = drivers.get(agentId)
      const instance = runtimeInstance(agentId, instanceId)
      const settings = instance.values
      // 只缓存 agent 自己的目录；模型偏好每次现取，改完设置立刻反映到选择器里。
      const models = await catalogs.get(instance.instanceId, async () =>
        normalizeModels(
          await listAgentModels(
            driver,
            await runtimeSettings(agentId, instanceId),
            driver?.accountSetup || driver?.requiresInstance
              ? instanceContext(instance)
              : undefined,
          ),
        ),
      )
      return applyModelPreferences(models, modelPreferences(settings))
    },
    async commands(agentId, instanceId, cwd, refresh) {
      const driver = drivers.get(agentId)
      if (!driver?.listCommands) return []
      const instance = runtimeInstance(agentId, instanceId)
      const list = driver.listCommands.bind(driver)
      return commandCatalogs.get(
        `${instance.instanceId}\0${cwd ?? ""}`,
        async () => {
          const execution =
            driver.accountSetup || driver.requiresInstance ? instanceContext(instance) : undefined
          const values = await runtimeSettings(agentId, instanceId)
          return normalizeCommands(
            await (execution ? list(values, cwd, execution) : list(values, cwd)).catch(() => []),
          )
        },
        refresh,
      )
    },
    async defaultAgent() {
      const configured = store()?.get(DEFAULT_AGENT_KEY)
      const chooseInstance = (id: string) => {
        const instances = listInstancesOf(id).filter((instance) => instance.enabled)
        const chosen = readDefaultInstanceId(store())
        return instances.find((instance) => instance.instanceId === chosen) ?? instances[0]
      }
      const agentId = await pickDefaultAgent({
        registered: [...drivers.keys()].filter((id) => chooseInstance(id) !== undefined),
        forced: forcedAgentId(),
        configured: typeof configured === "string" ? configured : undefined,
        status: (id) => detectOne(id, chooseInstance(id)?.instanceId ?? id),
      })
      if (!agentId) return { agentId: null, instanceId: null }
      return { agentId, instanceId: chooseInstance(agentId)?.instanceId ?? agentId }
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
        agentId && instanceId && !instanceFor(agentId, instanceId).isDefault
          ? instanceId
          : undefined,
      )
    },
    updateSettings(agentId, values, instanceId) {
      const settings = requireStore()
      const previous = instanceFor(agentId, instanceId).values
      return secrets.write(normalizeAgentSettings(values), previous, (sealed) => {
        if (instanceId && !instanceFor(agentId, instanceId).isDefault)
          updateStoredInstance(settings, instanceId, { values: sealed })
        else
          settings.set(agentSettingsKey(agentId), Object.keys(sealed).length ? sealed : undefined)
        invalidate(instanceId ?? agentId)
        return publicValues(sealed)
      })
    },
    instances: listInstancesOf,
    findInstance(instanceId) {
      const item = findInstanceWith(instanceId)
      return item ? exposed(item) : null
    },
    createInstance(agentId, label, options) {
      const explicitOnly = Boolean(drivers.get(agentId)?.requiresInstance)
      if (
        options?.instanceId &&
        drivers.has(options.instanceId) &&
        !(explicitOnly && options.instanceId === agentId)
      ) {
        throw new AgentInstanceIdTakenError(options.instanceId)
      }
      const create = (values?: AgentSettingsValues) => {
        const created = createStoredInstance(
          requireStore(),
          agentId,
          label.trim() || drivers.get(agentId)?.displayName || agentId,
          values ? { ...options, values } : options,
          explicitOnly,
        )
        invalidate(created.instanceId)
        return exposed(created)
      }
      return options?.values
        ? secrets.write(
            options.values,
            options.copyFrom ? instanceFor(agentId, options.copyFrom).values : {},
            create,
          )
        : create()
    },
    updateInstance(instanceId, patch) {
      const previous = findInstanceWith(instanceId)
      if (
        previous?.isDefault &&
        drivers.get(instanceId)?.accountSetup &&
        patch.enabled !== undefined &&
        patch.label === undefined &&
        patch.accentColor === undefined &&
        patch.values === undefined
      ) {
        requireStore().set(defaultInstanceEnabledKey(instanceId), patch.enabled)
        invalidate(instanceId)
        return exposed(instanceFor(instanceId, instanceId))
      }
      const update = (values?: AgentSettingsValues) => {
        const label =
          patch.label === undefined
            ? undefined
            : patch.label.trim() ||
              drivers.get(previous?.agentId ?? "")?.displayName ||
              previous?.agentId
        const updated = updateStoredInstance(requireStore(), instanceId, {
          ...patch,
          ...(label !== undefined ? { label } : {}),
          ...(values ? { values } : {}),
        })
        invalidate(instanceId)
        return exposed(updated)
      }
      return patch.values ? secrets.write(patch.values, previous?.values ?? {}, update) : update()
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
      if (instance) secrets.remove(instance.values)
      return instance ? exposed(instance) : null
    },
    invalidate,
  }

  /** 一个 agent 的实例；agent 不在已注册列表里时也按默认实例返回一份。 */
  function listInstancesOf(agentId: string): ResolvedInstance[] {
    const driver = drivers.get(agentId)
    const instances = listStoredInstances(store(), agentId, driver?.displayName ?? agentId)
    return (
      driver?.acpRegistry || driver?.requiresInstance
        ? instances.filter((instance) => !instance.isDefault)
        : instances
    ).map((instance) => {
      const scope = instanceContext(instance)
      const modes = scope && driver?.modesForInstance?.(scope)
      return { ...exposed(instance), ...(modes ? { executionModes: modes } : {}) }
    })
  }

  /** 按 instanceId 找实例：默认实例的 id 就是某个已注册 agent 的 id。 */
  function findInstanceWith(instanceId: string): ResolvedInstance | null {
    const stored = readStoredInstances(store())[instanceId]
    if (stored) return instanceFor(stored.agentId, instanceId)
    if (
      drivers.has(instanceId) &&
      !drivers.get(instanceId)?.requiresInstance &&
      !drivers.get(instanceId)?.acpRegistry
    )
      return instanceFor(instanceId)
    return null
  }
}
