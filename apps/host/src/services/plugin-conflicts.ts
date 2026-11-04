/**
 * provides 冲突：一份规则，插件列表、启停检查和 Host 入口的对账都用它。
 * 加载顺序就是列表顺序（内置插件在前，其余按 plugins.yml 的顺序）：同一个服务先声明的插件保留，
 * 后声明的整条记录不加载并记下原因；停用或本来就有错的插件不加载，也不占用服务。
 * 同一插件重复声明同一个服务同样算冲突。
 */
import type { PluginRecord } from "./plugin-manager"

/**
 * 按加载顺序（内置插件在前，其余按 plugins.yml 的顺序）解析 provides：
 * 同一个服务标识先声明的插件保留，后声明的整条记录不加载并记下冲突原因。
 * 停用或本来就有错（manifest 不可用、engines/apiVersion 不兼容）的插件不加载，也不占用服务标识。
 * 同一插件重复声明同一个服务同样算冲突。
 */
export function resolveProvidesConflicts(records: PluginRecord[]): void {
  const owners = new Map<string, string>()
  for (const record of records) {
    record.conflict = null
    if (record.disabled || record.error) continue
    const services = record.manifest?.pigcode.provides ?? []
    const conflicts = new Set<string>()
    const declared = new Set<string>()
    for (const service of services) {
      const owner = owners.get(service)
      if (owner !== undefined) conflicts.add(`${service} is already provided by ${owner}`)
      else if (declared.has(service)) conflicts.add(`${service} is declared more than once`)
      declared.add(service)
    }
    if (conflicts.size > 0) {
      record.conflict = `PROVIDES_CONFLICT: ${[...conflicts].join("; ")}`
      // 冲突的插件整条不加载，它声明的其余服务也一并留给后面的插件。
      continue
    }
    for (const service of services) owners.set(service, record.id)
  }
}

/**
 * 按当前列表判断某个插件是否已经拿不到服务（和列表、boot graph 用同一套规则）。
 * 例如赢家被重装、去掉了那个服务之后，原来因冲突没加载的插件可以接上。
 */
export function providesConflictOf(id: string, records: readonly PluginRecord[]): string | null {
  const copies = records.map((item) => ({ ...item, conflict: null }))
  resolveProvidesConflicts(copies)
  return copies.find((item) => item.id === id)?.conflict ?? null
}

/**
 * 目标插件启用时会不会和已经在提供服务的插件重复。停用的、被停用的、以及已经因冲突不加载的
 * 插件不算占位；同一插件重复声明同一个服务算它自己的冲突。
 */
export function enableConflictOf(
  record: PluginRecord,
  records: readonly PluginRecord[],
): string | null {
  const services = record.manifest?.pigcode.provides ?? []
  const declared = new Set<string>()
  for (const service of services) {
    if (declared.has(service)) return `${service} is declared more than once`
    declared.add(service)
  }
  for (const other of records) {
    if (other.id === record.id || other.disabled || other.error || other.conflict) continue
    const shared = (other.manifest?.pigcode.provides ?? []).find((service) => declared.has(service))
    if (shared !== undefined) return `${shared} is already provided by ${other.id}`
  }
  return null
}
