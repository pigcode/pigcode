/** 把 plugin manager 暴露为 Host 服务，并负责把插件的 Host 入口挂到 Cordis loader 上。 */
import type { EntryOptions } from "@cordisjs/plugin-loader"
import type { Context } from "cordis"
import { writeBootGraph } from "../kernel/boot"
import {
  buildBootGraph,
  hostEntryUrl,
  installLocalPlugin,
  installPlugin,
  listPlugins,
  readPluginRecords,
  setPluginEnabled,
  uninstallPlugin,
  type BootGraphEntry,
  type InstalledPluginEntry,
  type PluginEnv,
  type PluginRecord,
  type PluginSummary,
} from "./plugin-manager"
import { providesConflictOf } from "./plugin-conflicts"

/** plugins 插件的配置：用户 profile 目录与内置插件包目录。 */
export interface PluginsConfig {
  profileDir: string
  /** 随应用内置的插件包目录（绝对路径），按顺序加载；缺省时没有内置插件。 */
  builtin?: string[]
}

/** Host 侧插件管理服务；支持本地目录、npm 包名/版本与 tarball 安装。 */
export interface PluginsService {
  list(): Promise<PluginSummary[]>
  /** 合并后的插件记录（含 manifest），供 agent 设置页读取 Agent 插件的贡献。 */
  records(): Promise<PluginRecord[]>
  /** 记录变更前先取一份，卸载后界面仍能按它清理设置。 */
  record(id: string): Promise<PluginRecord>
  install(spec: string): Promise<InstalledPluginEntry>
  installLocal(sourceDir: string): Promise<InstalledPluginEntry>
  /** 卸载用户安装的插件；内置插件只能停用。 */
  uninstall(id: string): Promise<void>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
  bootGraph(): Promise<{ entries: BootGraphEntry[] }>
  /** 按当前插件列表让 Host 入口与之一致：该加载的加载，不该留下的卸掉。 */
  loadAll(): Promise<void>
  /** 重新读取插件列表并让 Host 入口与之一致；插件页的「刷新」用。 */
  reload(): Promise<void>
  /** Host 入口 import 或 apply 失败的插件 id；它们的界面代码不进 boot graph。 */
  hostFailures(): ReadonlySet<string>
}

declare module "cordis" {
  interface Context {
    plugins: PluginsService
  }
}

/** loader 创建条目时使用的选项；运行时会保留显式传入的 id。 */
type LoaderCreateOptions = Omit<EntryOptions, "id"> & { id?: string }

/** 把未知异常转成可展示文案。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** plugins 插件的函数签名；Cordis 从函数对象读取 inject。 */
export interface PluginsPlugin {
  (ctx: Context, config: PluginsConfig): void
  inject: string[]
}

/** plugins 插件依赖 Cordis loader 做动态挂载。 */
export const inject = ["loader"]

/** 注册 plugins 服务；启停插件时同步更新 loader 与 boot graph。 */
export const apply: PluginsPlugin = (ctx, config) => {
  const env: PluginEnv = { profileDir: config.profileDir, builtin: config.builtin ?? [] }
  // 加载失败只记录在内存里，供 list 合并展示；重启后重新尝试。
  const loadErrors = new Map<string, string>()
  // Host 入口 import 或 apply 失败的插件：它们的界面代码也不加载，错误显示在插件页。
  const hostFailures = new Set<string>()

  /** 确认 loader 条目完成 apply；import 失败时 loader 只记日志不抛错。 */
  async function settleEntry(id: string, url: string): Promise<void> {
    const entry = ctx.loader.store[id]
    if (!entry?.fiber) {
      hostFailures.add(id)
      failedAt.set(id, { entry: ctx.loader.store[id]?.options?.name, url })
      loadErrors.set(id, `plugin host entry failed to load: ${url}`)
      return
    }
    try {
      await entry.fiber.await()
      hostFailures.delete(id)
      failedAt.delete(id)
      loadErrors.delete(id)
    } catch (error) {
      hostFailures.add(id)
      failedAt.set(id, { entry: ctx.loader.store[id]?.options?.name, url })
      loadErrors.set(id, `plugin host entry failed to apply: ${errorMessage(error)}`)
    }
  }

  /**
   * 这个插件现在应该加载 Host 入口：启用、有入口、没有 manifest 错误或 provides 冲突，
   * 而且它声明的服务确实归它。最后一条覆盖了加载后列表又变了的情况（例如胜者被重装、去掉了那个服务）。
   */
  async function wantsHost(
    record: PluginRecord,
    records: readonly PluginRecord[],
  ): Promise<boolean> {
    if (record.disabled || hostEntryUrl(record) === null || record.error || record.conflict) {
      return false
    }
    return providesConflictOf(record.id, records) === null
  }

  /**
   * 加载过但 import / apply 失败的插件。失败的条目还留在 loader 里，先卸掉才能重试。
   * Cordis 的 Fiber 不公开错误状态，所以这里是记下的失败原因，外加当时 loader 里那个条目的入口：
   * 插件被重装、换了解包目录后这个入口和列表里的不一样，旧条目就不能再留着冒充新版本。
   */
  const failedAt = new Map<string, { entry: string | undefined; url: string }>()

  /** 这个插件在 loader 里的条目是不是已经不是列表里的那个入口（重装、重新解包）。 */
  function staleEntry(id: string): boolean {
    const failed = failedAt.get(id)
    if (failed === undefined) return false
    const loaded = ctx.loader.store[id]?.options?.name
    return failed.entry !== undefined && loaded !== undefined && loaded !== failed.entry
  }

  function failedEntry(record: PluginRecord): boolean {
    const failed = failedAt.get(record.id)
    if (failed === undefined) return false
    if (failed.url === hostEntryUrl(record)) return true
    // 入口路径变了：旧错误作废，旧条目在 reconcile 里按 staleEntry 卸掉后重建。
    failedAt.delete(record.id)
    loadErrors.delete(record.id)
    hostFailures.delete(record.id)
    return false
  }

  /** 为启用的插件创建 loader 条目；没有 Host 入口、已停用或不兼容的跳过。 */
  async function loadRecord(record: PluginRecord): Promise<void> {
    const url = hostEntryUrl(record)
    if (record.disabled || !url || ctx.loader.store[record.id]) return
    // 有错（不兼容、manifest 不可用、provides 冲突）的插件不加载 Host 入口；
    // 原因都在记录里，list() 直接展示，不再重复记一条加载错误。
    if (record.error || record.conflict) return
    const options: LoaderCreateOptions = { id: record.id, name: url, config: record.config ?? {} }
    try {
      await ctx.loader.create(options)
      await ctx.loader.await()
      await settleEntry(record.id, url)
    } catch (error) {
      hostFailures.add(record.id)
      failedAt.set(record.id, { entry: ctx.loader.store[record.id]?.options?.name, url })
      loadErrors.set(record.id, `plugin failed to load: ${errorMessage(error)}`)
    }
  }

  /** 移除 loader 条目，并等待插件 effect 清理完成。 */
  async function unloadEntry(id: string): Promise<void> {
    const entry = ctx.loader.store[id]
    loadErrors.delete(id)
    hostFailures.delete(id)
    failedAt.delete(id)
    if (!entry) return
    const fiber = entry.fiber
    ctx.loader.remove(id)
    try {
      // remove 先删 store 再 dispose，loader.await() 已经看不到该条目。
      await fiber?.await()
    } catch {
      // 卸载阶段的错误不影响停用结果。
    }
    await ctx.loader.await()
  }

  /** 写 boot graph；Host 入口失败的插件不写进界面启动图。 */
  async function updateBootGraph(): Promise<void> {
    await writeBootGraph(env, hostFailures)
  }

  async function recordOf(id: string): Promise<PluginRecord> {
    const record = (await readPluginRecords(env)).find((item) => item.id === id)
    if (!record) throw new Error(`plugin not found: ${id}`)
    return record
  }

  /**
   * 让 Host 入口与插件列表一致：该加载的加载，不该留下的卸掉。
   * 停用、卸载或重装冲突的一方后，原来因冲突没加载的插件在这里接上；
   * 反过来，新判定为冲突的插件（例如赢家卸掉后它的另一个服务被占了）也在这里卸掉，
   * 不会出现插件页说「冲突、不加载」而 Host 入口还在跑的情况。
   * 加载过但 apply 失败的条目先卸掉再重建，修好插件后刷新一次就能恢复。
   */
  async function reconcile(): Promise<void> {
    const records = await readPluginRecords(env)
    for (const record of records) {
      if (!(await wantsHost(record, records))) await unloadEntry(record.id)
    }
    for (const record of records) {
      if (!(await wantsHost(record, records))) continue
      // 失败的条目先卸掉再重建；换了入口的旧条目也卸掉，否则新版本不会真正 import。
      // 先看旧条目：failedEntry 在入口路径变化时会清掉记录，之后再看就晚了。
      const stale = staleEntry(record.id)
      if (failedEntry(record) || stale) await unloadEntry(record.id)
      await loadRecord(record)
    }
  }

  /** 安装后加载新条目；重装同一个插件时先卸下旧的入口。 */
  async function afterInstall(entry: InstalledPluginEntry): Promise<InstalledPluginEntry> {
    // 重装可能去掉或增加一个 provides：整表重新对一遍，先卸掉旧入口再按新状态加载。
    await unloadEntry(entry.id)
    await reconcile()
    await updateBootGraph()
    return entry
  }

  ctx.provide("plugins", {
    list: async () => {
      const summaries = await listPlugins(env)
      return summaries.map((summary) => {
        const loadError = loadErrors.get(summary.id)
        // manifest 错误优先；加载错误只在没有其他错误时展示。
        return loadError && !summary.error ? { ...summary, error: loadError } : summary
      })
    },
    records: () => readPluginRecords(env),
    record: recordOf,
    install: async (spec) => afterInstall(await installPlugin(env, spec)),
    installLocal: async (sourceDir) => afterInstall(await installLocalPlugin(env, sourceDir)),
    uninstall: async (id) => {
      const record = await recordOf(id)
      if (record.builtin) throw new Error(`PLUGIN_BUILTIN: ${record.name} can only be disabled`)
      // 先卸掉自己的入口（它的 effect 要能正常收尾），再删记录：它声明的服务空出来，
      // 原来因冲突没加载的插件在 reconcile 里接上。
      await unloadEntry(id)
      await uninstallPlugin(env, id)
      await reconcile()
      await updateBootGraph()
    },
    enable: async (id) => {
      await setPluginEnabled(env, id, true)
      await reconcile()
      await updateBootGraph()
    },
    disable: async (id) => {
      await setPluginEnabled(env, id, false)
      await reconcile()
      await updateBootGraph()
    },
    reload: async () => {
      await reconcile()
      await updateBootGraph()
    },
    bootGraph: () => buildBootGraph(env, hostFailures),
    hostFailures: () => hostFailures,
    loadAll: reconcile,
  })
}

apply.inject = inject
