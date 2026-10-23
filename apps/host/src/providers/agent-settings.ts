/**
 * agent 设置在 Host 里的存取：每个 provider 的值存在 settings 服务的 `providers.<id>` 下，
 * 默认 agent 存在 `agents.defaultProvider`。只读检测的结果按 provider 短时缓存。
 */
import {
  CUSTOM_MODELS_KEY,
  customModelsSchema,
  type ProviderSettingsValues,
  type ProviderStatus,
} from "@pigcode/contracts"
import type { SettingsService } from "../services/settings"

/** 用户选择的默认 agent。 */
export const DEFAULT_PROVIDER_KEY = "agents.defaultProvider"

/** 一个 agent 的设置在 settings 服务里的键。 */
export function providerSettingsKey(providerId: string): string {
  return `providers.${providerId}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 读取 agent 的设置；没有 settings 服务或存的不是对象时视为没有设置。 */
export function readProviderSettings(
  settings: SettingsService | undefined,
  providerId: string,
): ProviderSettingsValues {
  const value = settings?.get(providerSettingsKey(providerId))
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
export function normalizeProviderSettings(values: Record<string, unknown>): ProviderSettingsValues {
  const result: ProviderSettingsValues = {}
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
export function customModelIds(settings: ProviderSettingsValues): string[] {
  const parsed = customModelsSchema.safeParse(settings[CUSTOM_MODELS_KEY])
  return parsed.success ? parsed.data : []
}

/** 选择默认 agent 需要的信息；registered 按注册顺序排列（内置 agent 在前）。 */
export interface DefaultProviderInput {
  registered: readonly string[]
  /** `PIGCODE_PROVIDER`：E2E 与手动冒烟用来强制指定。 */
  forced: string | undefined
  /** 用户在设置页选择的默认 agent。 */
  configured: string | undefined
  status(providerId: string): Promise<ProviderStatus>
}

/**
 * 新会话的默认 agent：强制指定 > 用户选择 > 第一个已安装且没有明确未登录的 > 第一个已注册的。
 * fake 只在被强制指定、或者没有任何别的 agent 时使用。都没有时返回 null。
 */
export async function pickDefaultProvider(input: DefaultProviderInput): Promise<string | null> {
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

/** 按 provider 缓存检测结果；同一时刻的重复检测共享一次子进程。 */
export interface DetectionCache {
  get(
    providerId: string,
    load: () => Promise<ProviderStatus>,
    refresh?: boolean,
  ): Promise<ProviderStatus>
  invalidate(providerId?: string): void
}

/**
 * 检测要运行 `--version` 与登录状态两个子进程。新建会话挑默认 agent、打开设置页、
 * 输入框列 agent 都会用到，所以短时间内复用；改了设置或用户点「重新检测」时跳过缓存。
 */
export function createDetectionCache(options: DetectionCacheOptions = {}): DetectionCache {
  const ttlMs = options.ttlMs ?? 30_000
  const now = options.now ?? Date.now
  const entries = new Map<string, { status: ProviderStatus; expiresAt: number }>()
  const inflight = new Map<string, Promise<ProviderStatus>>()
  return {
    get(providerId, load, refresh = false) {
      const cached = entries.get(providerId)
      if (!refresh && cached && cached.expiresAt > now()) return Promise.resolve(cached.status)
      const pending = inflight.get(providerId)
      if (pending && !refresh) return pending
      const request = load()
        .catch((error: unknown): ProviderStatus => ({
          installed: false,
          version: null,
          authenticated: null,
          error: error instanceof Error ? error.message : String(error),
        }))
        .then((status) => {
          if (inflight.get(providerId) === request) {
            entries.set(providerId, { status, expiresAt: now() + ttlMs })
          }
          return status
        })
        .finally(() => {
          if (inflight.get(providerId) === request) inflight.delete(providerId)
        })
      inflight.set(providerId, request)
      return request
    },
    invalidate(providerId) {
      if (providerId === undefined) {
        entries.clear()
        inflight.clear()
        return
      }
      entries.delete(providerId)
      inflight.delete(providerId)
    },
  }
}
