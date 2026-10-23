/**
 * Host 设置：以 JSON 文件持久化的键值表，例如每个 agent 的设置与默认 agent。
 * 没有配置路径时只存在内存里（单元测试）。文件写坏或被手改坏时备份后从空表开始，不阻止 Host 启动。
 */
import type { Context } from "cordis"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

/** 设置读写入口；值必须可 JSON 序列化。 */
export interface SettingsService {
  get(key: string): unknown
  /** 写入并立即落盘；value 为 undefined 时删除该键。 */
  set(key: string, value: unknown): void
  snapshot(): Readonly<Record<string, unknown>>
  /** 订阅变化；返回取消订阅函数。 */
  onChange(listener: (key: string, value: unknown) => void): () => void
}

declare module "cordis" {
  interface Context {
    settings: SettingsService
  }
}

/** settings 插件的配置；path 缺省时不落盘。 */
export interface SettingsConfig {
  path?: string
}

/** 读取设置文件；不存在时返回空表，解析失败时把坏文件改名备份。 */
export function loadSettingsFile(path: string): Record<string, unknown> {
  let source: string
  try {
    source = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
    throw error
  }
  try {
    const parsed: unknown = JSON.parse(source)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // 落到下面统一备份。
  }
  renameSync(path, `${path}.corrupt-${Date.now()}`)
  return {}
}

/** 先写临时文件再改名，进程中途退出也不会留下半个文件。 */
function writeSettingsFile(path: string, values: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(values, null, 2)}\n`, "utf8")
  renameSync(temp, path)
}

/** 注册 settings 服务。 */
export function apply(ctx: Context, config: SettingsConfig = {}): void {
  const path = config.path
  let values: Record<string, unknown> = path ? loadSettingsFile(path) : {}
  const listeners = new Set<(key: string, value: unknown) => void>()

  const service: SettingsService = {
    get: (key) => values[key],
    set(key, value) {
      const next = { ...values }
      if (value === undefined) delete next[key]
      else next[key] = JSON.parse(JSON.stringify(value)) as unknown
      if (path) writeSettingsFile(path, next)
      values = next
      for (const listener of [...listeners]) listener(key, values[key])
    },
    snapshot: () => values,
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  ctx.provide("settings", service)
  ctx.effect(() => () => listeners.clear())
}
