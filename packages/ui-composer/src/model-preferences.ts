/** 模型选择的本机偏好：收藏的模型、每个模型上次选的思考深度。所有输入框共用一份。 */
import { useSyncExternalStore } from "react"
import type { ReasoningEffort } from "@pigcode/contracts"

const FAVORITES_KEY = "pigcode.favoriteModels"
const EFFORTS_KEY = "pigcode.modelEfforts"

/** 模型的全局键：agent 与模型 id 一起才唯一。 */
export function modelKey(agentId: string, modelId: string): string {
  return `${agentId}/${modelId}`
}

interface Preferences {
  favorites: readonly string[]
  efforts: Readonly<Record<string, ReasoningEffort>>
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

function read(): Preferences {
  if (cache) return cache
  const favorites = readJson<unknown>(FAVORITES_KEY, [])
  const efforts = readJson<unknown>(EFFORTS_KEY, {})
  cache = {
    favorites: Array.isArray(favorites)
      ? favorites.filter((item): item is string => typeof item === "string")
      : [],
    efforts:
      typeof efforts === "object" && efforts !== null && !Array.isArray(efforts)
        ? (efforts as Record<string, ReasoningEffort>)
        : {},
  }
  return cache
}

function write(next: Preferences): void {
  cache = next
  try {
    window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(next.favorites))
    window.localStorage.setItem(EFFORTS_KEY, JSON.stringify(next.efforts))
  } catch {
    // 存储不可用时只在本次运行内生效。
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === FAVORITES_KEY || event.key === EFFORTS_KEY) {
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

const EMPTY: Preferences = { favorites: [], efforts: {} }

/** 读取模型偏好；任何一个输入框修改后其他输入框同步更新。 */
export function useModelPreferences(): Preferences & {
  toggleFavorite: (key: string) => void
  setEffort: (key: string, effort: ReasoningEffort) => void
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
      write({ ...current, efforts: { ...current.efforts, [key]: effort } })
    },
  }
}

/** 测试用：清空缓存，重新从 localStorage 读取。 */
export function resetModelPreferencesCache(): void {
  cache = null
}
