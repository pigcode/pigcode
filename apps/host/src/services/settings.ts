/**
 * Host 设置：以 JSON 文件持久化的键值表，例如每个 agent 的设置与默认 agent。
 * 没有配置路径时只存在内存里（单元测试）。文件写坏或被手改坏时备份后从空表开始，不阻止 Host 启动。
 */
import type { Context } from "cordis"
import { readFileSync, renameSync } from "node:fs"
import { writeFileAtomicSync } from "./atomic-write"
import { backupBeforeRenameSync, migrateLegacySettings } from "./legacy-names"

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

/** 原子写入（临时文件 + fsync + 改名），进程中途退出也不会留下空的或半个文件。 */
function writeSettingsFile(path: string, values: Record<string, unknown>): void {
  writeFileAtomicSync(path, `${JSON.stringify(values, null, 2)}\n`)
}

/**
 * 把旧名字迁移后的设置写回文件，先备份原文件（见 legacy-names.ts）。备份或写入失败（只读 profile、
 * 磁盘满）时只记日志：迁移后的值留在内存里照常使用，下一次 set 会把整份设置写回去。
 * settings 服务必须起来，否则 Host 没有设置服务，agent 设置与默认 agent 全部失效。
 */
function persistMigratedSettings(path: string, values: Record<string, unknown>): void {
  try {
    if (!backupBeforeRenameSync(path)) {
      console.error(`[host] could not back up ${path}; keeping the migrated settings in memory`)
      return
    }
    writeSettingsFile(path, values)
  } catch (error) {
    console.error(`[host] could not write the migrated settings to ${path}:`, error)
  }
}

/** 注册 settings 服务。 */
export function apply(ctx: Context, config: SettingsConfig = {}): void {
  const path = config.path
  // 旧版本用旧名字保存的 agent 设置先迁移；已经迁移过时不写文件。
  const migrated = migrateLegacySettings(path ? loadSettingsFile(path) : {})
  if (path && migrated.changed) persistMigratedSettings(path, migrated.values)
  let values: Record<string, unknown> = migrated.values
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
