/**
 * 模型选择的本机偏好：收藏的模型、每个模型选的思考深度、哪些模型开了快速模式与 Ultracode。所有输入框共用一份。
 * 选「默认」就删掉这个模型的档位，没有档位的模型发送时不带思考深度；两个开关都只记开着的模型。
 */
import { useSyncExternalStore } from "react"
import type { ReasoningEffort } from "@pigcode/contracts"
import {
  resolveEffort,
  resolveModel,
  resolveSwitch,
  type ComposerModelCatalog,
  type ModelSwitch,
} from "./composer-options"

const FAVORITES_KEY = "pigcode.favoriteModels"
const EFFORTS_KEY = "pigcode.modelEfforts"
/** 每个开关一份「开着的模型」列表。 */
const SWITCH_KEYS: Record<ModelSwitch, string> = {
  fast: "pigcode.fastModels",
  ultracode: "pigcode.ultracodeModels",
}
const KEYS = new Set([FAVORITES_KEY, EFFORTS_KEY, ...Object.values(SWITCH_KEYS)])

/** 模型的全局键：agent 与模型 id 一起才唯一。 */
export function modelKey(agentId: string, modelId: string): string {
  return `${agentId}/${modelId}`
}

interface Preferences {
  favorites: readonly string[]
  efforts: Readonly<Record<string, ReasoningEffort>>
  /** 每个开关下开着的模型键。 */
  switches: Readonly<Record<ModelSwitch, readonly string[]>>
}

const listeners = new Set<() => void>()
let cache: Preferences | null = null

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

/** 读一个字符串数组；格式不对时当作空。 */
function readList(key: string): string[] {
  const value = readJson<unknown>(key, [])
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function read(): Preferences {
  if (cache) return cache
  const efforts = readJson<unknown>(EFFORTS_KEY, {})
  cache = {
    favorites: readList(FAVORITES_KEY),
    efforts:
      typeof efforts === "object" && efforts !== null && !Array.isArray(efforts)
        ? (efforts as Record<string, ReasoningEffort>)
        : {},
    switches: { fast: readList(SWITCH_KEYS.fast), ultracode: readList(SWITCH_KEYS.ultracode) },
  }
  return cache
}

function write(next: Preferences): void {
  cache = next
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next.favorites))
    window.localStorage.setItem(EFFORTS_KEY, JSON.stringify(next.efforts))
    for (const [name, key] of Object.entries(SWITCH_KEYS)) {
      window.localStorage.setItem(key, JSON.stringify(next.switches[name as ModelSwitch]))
    }
  } catch {
    // 存储不可用时只在本次运行内生效。
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && KEYS.has(event.key)) {
      cache = null
      listener()
    }
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

const EMPTY: Preferences = { favorites: [], efforts: {}, switches: { fast: [], ultracode: [] } }

/** 读取模型偏好；任何一个输入框修改后其他输入框同步更新。 */
export function useModelPreferences(): Preferences & {
  toggleFavorite: (key: string) => void
  setEffort: (key: string, effort: ReasoningEffort | null) => void
  setSwitch: (name: ModelSwitch, key: string, on: boolean) => void
} {
  const preferences = useSyncExternalStore(subscribe, read, () => EMPTY)
  return {
    ...preferences,
    toggleFavorite: (key) => {
      const current = read()
      write({
        ...current,
        favorites: current.favorites.includes(key)
          ? current.favorites.filter((item) => item !== key)
          : [...current.favorites, key],
      })
    },
    setEffort: (key, effort) => {
      const current = read()
      const others = Object.fromEntries(
        Object.entries(current.efforts).filter(([model]) => model !== key),
      )
      write({ ...current, efforts: effort ? { ...others, [key]: effort } : others })
    },
    setSwitch: (name, key, on) => {
      const current = read()
      const others = current.switches[name].filter((item) => item !== key)
      write({
        ...current,
        switches: { ...current.switches, [name]: on ? [...others, key] : others },
      })
    },
  }
}

/** 发送时用的思考深度、快速模式与 Ultracode：当前模型支持、并且用户为它选过的那些。 */
export function useRunPreferences(
  agentId: string | null,
  catalog: ComposerModelCatalog,
  modelId: string | null,
): { effort: ReasoningEffort | null; fast: boolean; ultracode: boolean } {
  const preferences = useModelPreferences()
  const model = resolveModel(agentId ? catalog[agentId] : undefined, modelId)
  const key = agentId && model ? modelKey(agentId, model.id) : null
  const on = (name: ModelSwitch) =>
    resolveSwitch(model, name, key ? preferences.switches[name].includes(key) : false)
  return {
    effort: resolveEffort(model, key ? preferences.efforts[key] : null),
    fast: on("fast"),
    ultracode: on("ultracode"),
  }
}

/** 测试用：清空缓存，重新从 localStorage 读取。 */
export function resetModelPreferencesCache(): void {
  cache = null
}
