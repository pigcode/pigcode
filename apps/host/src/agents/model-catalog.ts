/** 模型目录：把各 driver 的模型条目统一成协议形状，追加用户的自定义模型，并缓存读取结果。 */
import { asReasoningEffort, sortEfforts } from "@pigcode/plugin-sdk"
import type { AgentModel } from "@pigcode/contracts"
import type { AgentModelInfo } from "./driver"

export { asReasoningEffort, sortEfforts }

/** 补齐可选字段、去掉重复 id；默认档位不在可选范围内时置空。 */
export function normalizeModels(models: readonly AgentModelInfo[]): AgentModel[] {
  const seen = new Set<string>()
  const result: AgentModel[] = []
  for (const model of models) {
    if (!model.id || seen.has(model.id)) continue
    seen.add(model.id)
    const efforts = sortEfforts(model.efforts ?? [])
    const defaultEffort =
      model.defaultEffort && efforts.includes(model.defaultEffort) ? model.defaultEffort : null
    result.push({
      id: model.id,
      displayName: model.displayName || model.id,
      ...(model.description ? { description: model.description } : {}),
      isDefault: model.isDefault,
      efforts,
      defaultEffort,
      ...(model.fast ? { fast: true } : {}),
      ...(model.ultracode ? { ultracode: true } : {}),
    })
  }
  return result
}

/**
 * 在 agent 自己的目录后面追加自定义模型；已经在目录里的 id 不重复添加。
 * 自定义模型没有可调的思考深度，由 CLI 自己决定。
 */
export function withCustomModels(
  models: readonly AgentModel[],
  customIds: readonly string[],
): AgentModel[] {
  const known = new Set(models.map((model) => model.id))
  const custom: AgentModel[] = []
  for (const raw of customIds) {
    const id = raw.trim()
    if (!id || known.has(id)) continue
    known.add(id)
    custom.push({
      id,
      displayName: id,
      isDefault: false,
      efforts: [],
      defaultEffort: null,
      custom: true,
    })
  }
  return [...models, ...custom]
}

/** 模型目录缓存的选项；测试可以注入时钟。 */
export interface ModelCatalogCacheOptions {
  ttlMs?: number
  now?: () => number
}

/** 按 Agent 缓存模型目录；同一时刻的重复请求共享一次读取。 */
export interface ModelCatalogCache {
  get(agentId: string, load: () => Promise<AgentModel[]>): Promise<AgentModel[]>
  invalidate(agentId?: string): void
}

/**
 * 读取目录可能要启动 CLI（Codex 起一个 app-server、Claude 起一次 SDK 会话），
 * 切换线程时不能每次都重新读。空目录不缓存，CLI 稍后装好或登录后能立刻看到模型。
 */
export function createModelCatalogCache(options: ModelCatalogCacheOptions = {}): ModelCatalogCache {
  const ttlMs = options.ttlMs ?? 10 * 60_000
  const now = options.now ?? Date.now
  const entries = new Map<string, { models: AgentModel[]; expiresAt: number }>()
  const inflight = new Map<string, Promise<AgentModel[]>>()
  return {
    get(agentId, load) {
      const cached = entries.get(agentId)
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.models)
      const pending = inflight.get(agentId)
      if (pending) return pending
      const request = load()
        .then((models) => {
          if (inflight.get(agentId) === request && models.length > 0) {
            entries.set(agentId, { models, expiresAt: now() + ttlMs })
          }
          return models
        })
        .finally(() => {
          if (inflight.get(agentId) === request) inflight.delete(agentId)
        })
      inflight.set(agentId, request)
      return request
    },
    invalidate(agentId) {
      if (agentId === undefined) {
        entries.clear()
        inflight.clear()
        return
      }
      entries.delete(agentId)
      inflight.delete(agentId)
    },
  }
}
