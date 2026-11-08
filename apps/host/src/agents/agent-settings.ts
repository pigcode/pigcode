/**
 * agent 与 agent 实例在 Host 里的存取：默认实例的值存在 settings 服务的 `agents.<agentId>` 下，
 * 其余实例存在 `agentInstances` 里；默认 Agent 存在 `defaultAgent`，默认实例存在 `defaultInstance`。
 * 只读检测的结果按实例短时缓存。
 */
import { randomUUID } from "node:crypto"
import {
  CUSTOM_MODELS_KEY,
  customModelsSchema,
  type AgentInstance,
  type AgentSettingsValues,
  type AgentStatus,
} from "@pigcode/contracts"
import type { SettingsService } from "../services/settings"

/** 环境变量 `PIGCODE_AGENT` 强制指定的 agent（E2E 与手动冒烟用）；空值视为没设。 */
export function forcedAgentId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.PIGCODE_AGENT || undefined
}

/** 用户选择的默认 agent。不放在 `agents.` 下：agent id 可以叫 default。 */
export const DEFAULT_AGENT_KEY = "defaultAgent"

/** 用户选择的默认实例；值为 instanceId。 */
export const DEFAULT_INSTANCE_KEY = "defaultInstance"

/** 默认实例以外、用户新建的实例；一个键存整张表，值见 StoredInstance。 */
export const AGENT_INSTANCES_KEY = "agentInstances"

/** 一个 agent 的默认实例设置在 settings 服务里的键。 */
export function agentSettingsKey(agentId: string): string {
  return `agents.${agentId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 读取 agent 默认实例的设置；没有 settings 服务或存的不是对象时视为没有设置。 */
export function readAgentSettings(
  settings: SettingsService | undefined,
  agentId: string,
): AgentSettingsValues {
  const value = settings?.get(agentSettingsKey(agentId))
  return isRecord(value) ? value : {}
}

/** 留空的值：空白字符串、空数组与 null，保存时去掉，driver 回到默认值。 */
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "string") return value.trim().length === 0
  return Array.isArray(value) && value.length === 0
}

/**
 * 规范化要保存的设置：去掉留空的项，自定义模型去首尾空白、去重。
 * 自定义模型的格式不对时抛出可读的错误，不写入。
 */
export function normalizeAgentSettings(values: Record<string, unknown>): AgentSettingsValues {
  const result: AgentSettingsValues = {}
  for (const [key, value] of Object.entries(values)) {
    if (isBlank(value)) continue
    if (key === CUSTOM_MODELS_KEY) {
      const parsed = customModelsSchema.safeParse(value)
      if (!parsed.success) throw new Error("customModels must be a list of model ids")
      const unique = [...new Set(parsed.data)]
      if (unique.length > 0) result[key] = unique
      continue
    }
    result[key] = value
  }
  return result
}

/** 自定义模型 id；没有或格式不对时为空。 */
export function customModelIds(settings: AgentSettingsValues): string[] {
  const parsed = customModelsSchema.safeParse(settings[CUSTOM_MODELS_KEY])
  return parsed.success ? parsed.data : []
}

/** 存在 `agentInstances` 里的一个实例；默认实例不存，直接读 `agents.<agentId>`。 */
export interface StoredInstance {
  agentId: string
  label: string
  enabled: boolean
  createdAt: string
  values: AgentSettingsValues
}

/** 读出全部实例；格式不对的项丢掉，不影响其余实例。 */
export function readStoredInstances(
  settings: SettingsService | undefined,
): Record<string, StoredInstance> {
  const value = settings?.get(AGENT_INSTANCES_KEY)
  if (!isRecord(value)) return {}
  const result: Record<string, StoredInstance> = {}
  for (const [instanceId, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.agentId !== "string" || raw.agentId.length === 0) continue
    if (typeof raw.label !== "string" || raw.label.length === 0) continue
    result[instanceId] = {
      agentId: raw.agentId,
      label: raw.label,
      enabled: raw.enabled !== false,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      values: isRecord(raw.values) ? raw.values : {},
    }
  }
  return result
}

function writeStoredInstances(
  settings: SettingsService,
  instances: Record<string, StoredInstance>,
): void {
  settings.set(AGENT_INSTANCES_KEY, Object.keys(instances).length > 0 ? instances : undefined)
}

/** 一个已解析的实例：默认实例补上 `agents.<agentId>` 的值。 */
export interface ResolvedInstance extends AgentInstance {
  createdAt: string | null
}

/**
 * 解析实例。不传 instanceId、或它等于 agentId、或它已经不是这个 agent 的实例时，
 * 都退回默认实例——线程记着的实例被删掉后仍然能继续，不会卡住。
 */
export function resolveInstance(
  settings: SettingsService | undefined,
  agentId: string,
  instanceId?: string | null,
): ResolvedInstance {
  const stored = instanceId ? readStoredInstances(settings)[instanceId] : undefined
  if (instanceId && stored && stored.agentId === agentId) {
    return {
      instanceId,
      agentId,
      label: stored.label,
      enabled: stored.enabled,
      values: stored.values,
      isDefault: false,
      createdAt: stored.createdAt || null,
    }
  }
  return {
    instanceId: agentId,
    agentId,
    label: agentId,
    enabled: true,
    values: readAgentSettings(settings, agentId),
    isDefault: true,
    createdAt: null,
  }
}

/** 一个 agent 的全部实例，默认实例在前，其余按创建时间排列。 */
export function listInstances(
  settings: SettingsService | undefined,
  agentId: string,
  displayName: string,
): ResolvedInstance[] {
  const stored = Object.entries(readStoredInstances(settings))
    .filter(([, instance]) => instance.agentId === agentId)
    .sort(([, left], [, right]) => left.createdAt.localeCompare(right.createdAt))
  return [
    { ...resolveInstance(settings, agentId), label: displayName },
    ...stored.map(([instanceId, instance]) => ({
      instanceId,
      agentId,
      label: instance.label,
      enabled: instance.enabled,
      values: instance.values,
      isDefault: false,
      createdAt: instance.createdAt || null,
    })),
  ]
}

/** 这个 instanceId 是不是某个 agent 的默认实例（默认实例就是 agent 自己，不额外存）。 */
export function isDefaultInstanceId(
  settings: SettingsService | undefined,
  instanceId: string,
): boolean {
  return readStoredInstances(settings)[instanceId] === undefined
}

/** 新建实例；复制来源的当前值作为初值，之后两份互不影响。 */
export function createInstance(
  settings: SettingsService,
  agentId: string,
  label: string,
  copyFrom?: string | null,
): ResolvedInstance {
  const instances = readStoredInstances(settings)
  const instanceId = `inst_${randomUUID()}`
  const source = resolveInstance(settings, agentId, copyFrom ?? agentId)
  const stored: StoredInstance = {
    agentId,
    label: label.trim(),
    enabled: true,
    createdAt: new Date().toISOString(),
    values: { ...source.values },
  }
  instances[instanceId] = stored
  writeStoredInstances(settings, instances)
  return {
    instanceId,
    agentId,
    label: stored.label,
    enabled: true,
    values: stored.values,
    isDefault: false,
    createdAt: stored.createdAt,
  }
}

/** 改实例的名称、启用状态或设置；返回改完的实例。 */
export function updateInstance(
  settings: SettingsService,
  instanceId: string,
  patch: {
    label?: string | undefined
    enabled?: boolean | undefined
    values?: Record<string, unknown> | undefined
  },
): ResolvedInstance {
  const instances = readStoredInstances(settings)
  const stored = instances[instanceId]
  if (!stored) throw new Error(`default instance cannot be edited as an instance: ${instanceId}`)
  const next: StoredInstance = {
    ...stored,
    ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.values !== undefined ? { values: normalizeAgentSettings(patch.values) } : {}),
  }
  instances[instanceId] = next
  writeStoredInstances(settings, instances)
  return {
    instanceId,
    agentId: next.agentId,
    label: next.label,
    enabled: next.enabled,
    values: next.values,
    isDefault: false,
    createdAt: next.createdAt || null,
  }
}

/** 删除实例；默认实例与不存在的实例不能删。 */
export function removeInstance(settings: SettingsService, instanceId: string): void {
  const instances = readStoredInstances(settings)
  if (!instances[instanceId]) throw new Error(`default instance cannot be removed: ${instanceId}`)
  delete instances[instanceId]
  writeStoredInstances(settings, instances)
}

/** 用户选择的默认实例 id；没选过或选的是默认实例时为 null。 */
export function readDefaultInstanceId(settings: SettingsService | undefined): string | null {
  const value = settings?.get(DEFAULT_INSTANCE_KEY)
  return typeof value === "string" && value.length > 0 ? value : null
}

/** 选择默认 agent 需要的信息；registered 按注册顺序排列（内置 agent 在前）。 */
export interface DefaultAgentInput {
  registered: readonly string[]
  /** 环境变量强制指定的 agent，见 forcedAgentId。 */
  forced: string | undefined
  /** 用户在设置页选择的默认 agent。 */
  configured: string | undefined
  status(agentId: string): Promise<AgentStatus>
}

/**
 * 新会话的默认 agent：强制指定 > 用户选择 > 第一个已安装且没有明确未登录的 > 第一个已注册的。
 * fake 只在被强制指定、或者没有任何别的 agent 时使用。都没有时返回 null。
 */
export async function pickDefaultAgent(input: DefaultAgentInput): Promise<string | null> {
  const registered = new Set(input.registered)
  if (input.forced && registered.has(input.forced)) return input.forced
  if (input.configured && registered.has(input.configured)) return input.configured
  const real = input.registered.filter((id) => id !== "fake")
  const statuses = await Promise.all(real.map((id) => input.status(id)))
  const ready = real.find(
    (_id, index) => statuses[index]?.installed && statuses[index]?.authenticated !== false,
  )
  return ready ?? real[0] ?? (registered.has("fake") ? "fake" : null)
}

/** 检测结果缓存的选项；测试可以注入时钟。 */
export interface DetectionCacheOptions {
  ttlMs?: number
  now?: () => number
}

/** 按实例缓存检测结果；同一时刻的重复检测共享一次子进程。 */
export interface DetectionCache {
  get(instanceId: string, load: () => Promise<AgentStatus>, refresh?: boolean): Promise<AgentStatus>
  invalidate(instanceId?: string): void
}

/**
 * 检测要运行 `--version` 与登录状态两个子进程。新建会话挑默认 agent、打开设置页、
 * 输入框列 agent 都会用到，所以短时间内复用；改了设置或用户点「重新检测」时跳过缓存。
 */
export function createDetectionCache(options: DetectionCacheOptions = {}): DetectionCache {
  const ttlMs = options.ttlMs ?? 30_000
  const now = options.now ?? Date.now
  const entries = new Map<string, { status: AgentStatus; expiresAt: number }>()
  const inflight = new Map<string, Promise<AgentStatus>>()
  return {
    get(instanceId, load, refresh = false) {
      const cached = entries.get(instanceId)
      if (!refresh && cached && cached.expiresAt > now()) return Promise.resolve(cached.status)
      const pending = inflight.get(instanceId)
      if (pending && !refresh) return pending
      const request = load()
        .catch((error: unknown): AgentStatus => ({
          installed: false,
          version: null,
          authenticated: null,
          error: error instanceof Error ? error.message : String(error),
        }))
        .then((status) => {
          if (inflight.get(instanceId) === request) {
            entries.set(instanceId, { status, expiresAt: now() + ttlMs })
          }
          return status
        })
        .finally(() => {
          if (inflight.get(instanceId) === request) inflight.delete(instanceId)
        })
      inflight.set(instanceId, request)
      return request
    },
    invalidate(instanceId) {
      if (instanceId === undefined) {
        entries.clear()
        inflight.clear()
        return
      }
      entries.delete(instanceId)
      inflight.delete(instanceId)
    },
  }
}
