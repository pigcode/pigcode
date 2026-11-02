/**
 * 旧名字的数据迁移（#33）：Agent 以前叫 provider。Host 启动时把用户 profile 里还用旧名字的数据改成新名字。
 *
 * - settings.json：`providers.<id>` → `agents.<id>`，`agents.defaultProvider` → `defaultAgent`；其他键不动。
 * - plugins.yml：插件 id `provider.<包名>` → `agent.<包名>`。内置插件的包也改了名
 *   （`@pigcode/provider-claude` → `@pigcode/agent-claude`，codex 同理），它们的条目连 name 一起改；
 *   用户安装的插件包名不变，安装目录（profile 的 node_modules/<包名>）也就不变。
 *
 * 冲突：新旧两个键（或新旧两条插件条目）都在时以新的为准，旧的删掉。
 * 例外：`agents.defaultProvider` 也是 id 叫 defaultProvider 的 Agent 迁移后的设置键。只有值是字符串（旧的
 * 默认 Agent id）时才当旧的默认键处理：`defaultAgent` 不存在时搬过去，存在时删掉；值是对象（某个 Agent 的设置）
 * 时不动，以后每次启动也不会把它误当成默认键。
 * 幂等：已经迁移过的数据原样返回，changed 为 false，调用方据此决定要不要写回文件，所以第二次启动什么都不改。
 *
 * 改写前的备份：数据有变化时，settings.json 与 plugins.yml 先各复制一份 `<文件>.pre-agent-rename.bak`
 * （已有同名备份时不覆盖，见 backupBeforeRename），数据库在迁移前复制成 `pigcode.db.schema-v<旧版本>.bak`
 * （storage/database.ts）。三份合起来就是升级前的 profile：要手工回到旧版本，退出 Pigcode，把三份备份改回
 * 原来的文件名（数据库还要删掉同名的 -wal、-shm 文件），再装回旧版本的 Pigcode。新版本不支持降级，
 * 旧版本打不开 v7 的 profile；备份只用于手工恢复，不会自动清理。
 * 数据库的列改名在 storage/migrations.ts。
 */
import { constants } from "node:fs"
import { copyFileSync } from "node:fs"
import { copyFile } from "node:fs/promises"
import { DEFAULT_AGENT_KEY, agentSettingsKey } from "../agents/agent-settings"
import type { InstalledPluginEntry } from "./plugin-manager"

/** 迁移改写 settings.json、plugins.yml 之前留的备份后缀。 */
export const PRE_RENAME_BACKUP_SUFFIX = ".pre-agent-rename.bak"

/** 旧版本保存 agent 设置的键前缀。 */
const LEGACY_SETTINGS_PREFIX = "providers."
/** 旧版本保存默认 agent 的键。 */
const LEGACY_DEFAULT_KEY = "agents.defaultProvider"
/** 旧插件 id 的种类前缀。 */
const LEGACY_PLUGIN_PREFIX = "provider."
/** 改了包名的内置插件：旧包名 → 新包名。 */
const RENAMED_BUILTIN_PACKAGES: Readonly<Record<string, string>> = {
  "@pigcode/provider-claude": "@pigcode/agent-claude",
  "@pigcode/provider-codex": "@pigcode/agent-codex",
}

/** 把旧键的值搬到新键；新键已经有值时保留新值，旧键总是删掉。 */
function moveKey(values: Record<string, unknown>, from: string, to: string): void {
  if (!(from in values)) return
  if (!(to in values)) values[to] = values[from]
  delete values[from]
}

/** 迁移 settings.json 里的 agent 设置与默认 agent；返回新对象，不改入参。 */
export function migrateLegacySettings(input: Readonly<Record<string, unknown>>): {
  values: Record<string, unknown>
  changed: boolean
} {
  const values = { ...input }
  // 先处理默认键：下面搬 `providers.defaultProvider` 时会用到 `agents.defaultProvider` 这个键名。
  if (typeof values[LEGACY_DEFAULT_KEY] === "string")
    moveKey(values, LEGACY_DEFAULT_KEY, DEFAULT_AGENT_KEY)
  for (const key of Object.keys(input)) {
    if (!key.startsWith(LEGACY_SETTINGS_PREFIX)) continue
    moveKey(values, key, agentSettingsKey(key.slice(LEGACY_SETTINGS_PREFIX.length)))
  }
  return { values, changed: Object.keys(input).some((key) => !(key in values)) }
}

/** 包名在迁移后的名字：只有改了名的内置插件包会变。 */
function renamedPackage(name: string): string {
  return RENAMED_BUILTIN_PACKAGES[name] ?? name
}

/** 旧 id 对应的新 id；不是旧 id 时返回 null。 */
function migratedPluginId(id: string): string | null {
  if (!id.startsWith(LEGACY_PLUGIN_PREFIX)) return null
  return `agent.${renamedPackage(id.slice(LEGACY_PLUGIN_PREFIX.length))}`
}

/**
 * 迁移 plugins.yml 的条目：旧 id 改成新 id，内置插件的包名一起改；同一个新 id 已有条目时丢掉旧条目。
 * 条目顺序不变。
 */
export function migrateLegacyPluginEntries(entries: readonly InstalledPluginEntry[]): {
  entries: InstalledPluginEntry[]
  changed: boolean
} {
  const current = new Set(
    entries.flatMap((entry) =>
      typeof entry?.id === "string" && migratedPluginId(entry.id) === null ? [entry.id] : [],
    ),
  )
  let changed = false
  const result: InstalledPluginEntry[] = []
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? migratedPluginId(entry.id) : null
    if (id === null) {
      result.push(entry)
      continue
    }
    changed = true
    if (current.has(id)) continue
    current.add(id)
    result.push(
      entry.builtin ? { ...entry, id, name: renamedPackage(entry.name) } : { ...entry, id },
    )
  }
  return { entries: changed ? result : [...entries], changed }
}

function isAlreadyBackedUp(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST"
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT"
}

/**
 * 迁移改写文件之前复制一份 `<文件>.pre-agent-rename.bak`。COPYFILE_EXCL 保证不覆盖以前的备份：
 * 已经有备份（上一次启动备份过、改写却没成功）时沿用它。返回 false 表示没能备份，调用方不该改写文件。
 */
export function backupBeforeRenameSync(path: string): boolean {
  try {
    copyFileSync(path, `${path}${PRE_RENAME_BACKUP_SUFFIX}`, constants.COPYFILE_EXCL)
    return true
  } catch (error) {
    return isAlreadyBackedUp(error) || isMissing(error)
  }
}

/** backupBeforeRenameSync 的异步版本。 */
export async function backupBeforeRename(path: string): Promise<boolean> {
  try {
    await copyFile(path, `${path}${PRE_RENAME_BACKUP_SUFFIX}`, constants.COPYFILE_EXCL)
    return true
  } catch (error) {
    return isAlreadyBackedUp(error) || isMissing(error)
  }
}
