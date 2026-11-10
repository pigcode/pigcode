/** 模型目录：把各 driver 的模型条目统一成协议形状，追加用户的自定义模型，并缓存读取结果。 */
import { asReasoningEffort, sortEfforts } from "@pigcode/plugin-sdk"
import type { AgentCommand, AgentModel } from "@pigcode/contracts"
import type { AgentCommandInfo, AgentModelInfo } from "./driver"

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

/** `/` 命令：去掉空名字与重复的插入文字，可选字段为空时省略。 */
export function normalizeCommands(commands: readonly AgentCommandInfo[]): AgentCommand[] {
  const seen = new Set<string>()
  const result: AgentCommand[] = []
  for (const command of commands) {
    const name = command.name?.trim()
    const text = command.text?.trim()
    if (!name || !text || seen.has(text)) continue
    seen.add(text)
    const description = command.description?.trim()
    const argumentHint = command.argumentHint?.trim()
    result.push({
      name,
      text,
      ...(description ? { description } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      kind: command.kind === "builtin" ? "builtin" : "skill",
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

/**
 * 按 key 缓存目录（模型目录按实例，`/` 命令按实例与工作目录）；同一时刻的重复请求共享一次读取。
 * invalidate 传实例 id 时丢掉这个实例的全部条目。
 */
export interface ModelCatalogCache<T = AgentModel> {
  get(key: string, load: () => Promise<T[]>): Promise<T[]>
  invalidate(prefix?: string): void
}

/**
 * 读取目录可能要启动 CLI（Codex 起一个 app-server、Claude 起一次 SDK 会话），
 * 切换线程时不能每次都重新读。空目录不缓存，CLI 稍后装好或登录后能立刻看到模型。
 */
export function createModelCatalogCache<T = AgentModel>(
  options: ModelCatalogCacheOptions = {},
): ModelCatalogCache<T> {
  const ttlMs = options.ttlMs ?? 10 * 60_000
  const now = options.now ?? Date.now
  const entries = new Map<string, { models: T[]; expiresAt: number }>()
  const inflight = new Map<string, Promise<T[]>>()
  /** key 是实例 id 本身，或「实例 id + \0 + 其余部分」。 */
  const owned = (key: string, prefix: string) => key === prefix || key.startsWith(`${prefix}\0`)
  return {
    get(key, load) {
      const cached = entries.get(key)
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.models)
      const pending = inflight.get(key)
      if (pending) return pending
      const request = load()
        .then((models) => {
          if (inflight.get(key) === request && models.length > 0) {
            entries.set(key, { models, expiresAt: now() + ttlMs })
          }
          return models
        })
        .finally(() => {
          if (inflight.get(key) === request) inflight.delete(key)
        })
      inflight.set(key, request)
      return request
    },
    invalidate(prefix) {
      if (prefix === undefined) {
        entries.clear()
        inflight.clear()
        return
      }
      for (const key of [...entries.keys()]) if (owned(key, prefix)) entries.delete(key)
      for (const key of [...inflight.keys()]) if (owned(key, prefix)) inflight.delete(key)
    },
  }
}
