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

/** plugins 插件的配置：用户 profile 目录与内置插件包目录。 */
export interface PluginsConfig {
  profileDir: string
  /** 随应用内置的插件包目录（绝对路径），按顺序加载；缺省时没有内置插件。 */
  builtin?: string[]
}

/** Host 侧插件管理服务；支持本地目录、npm 包名/版本与 tarball 安装。 */
export interface PluginsService {
  list(): Promise<PluginSummary[]>
  /** 合并后的插件记录（含 manifest），供 agent 设置页读取 provider 贡献。 */
  records(): Promise<PluginRecord[]>
  install(spec: string): Promise<InstalledPluginEntry>
  installLocal(sourceDir: string): Promise<InstalledPluginEntry>
  /** 卸载用户安装的插件；内置插件只能停用。 */
  uninstall(id: string): Promise<void>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
  bootGraph(): Promise<{ entries: BootGraphEntry[] }>
  /** Host 启动时加载全部已启用插件的 Host 入口；单个插件失败只记录错误。 */
  loadAll(): Promise<void>
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

  /** 确认 loader 条目完成 apply；import 失败时 loader 只记日志不抛错。 */
  async function settleEntry(id: string, name: string): Promise<void> {
    const entry = ctx.loader.store[id]
    if (!entry?.fiber) {
      loadErrors.set(id, `plugin host entry failed to load: ${name}`)
      return
    }
    try {
      await entry.fiber.await()
      loadErrors.delete(id)
    } catch (error) {
      loadErrors.set(id, `plugin host entry failed to apply: ${errorMessage(error)}`)
    }
  }

  /** 为启用的插件创建 loader 条目；没有 Host 入口、已停用或不兼容的跳过。 */
  async function loadRecord(record: PluginRecord): Promise<void> {
    const url = hostEntryUrl(record)
    if (record.disabled || !url || ctx.loader.store[record.id]) return
    if (record.error) {
      loadErrors.set(record.id, record.error)
      return
    }
    const options: LoaderCreateOptions = { id: record.id, name: url, config: record.config ?? {} }
    try {
      await ctx.loader.create(options)
      await ctx.loader.await()
      await settleEntry(record.id, record.name)
    } catch (error) {
      loadErrors.set(record.id, `plugin failed to load: ${errorMessage(error)}`)
    }
  }

  /** 移除 loader 条目，并等待插件 effect 清理完成。 */
  async function unloadEntry(id: string): Promise<void> {
    const entry = ctx.loader.store[id]
    loadErrors.delete(id)
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

  async function recordOf(id: string): Promise<PluginRecord> {
    const record = (await readPluginRecords(env)).find((item) => item.id === id)
    if (!record) throw new Error(`plugin not found: ${id}`)
    return record
  }

  /** 安装后加载新条目；重装同一个插件时先卸下旧的入口。 */
  async function afterInstall(entry: InstalledPluginEntry): Promise<InstalledPluginEntry> {
    await unloadEntry(entry.id)
    await loadRecord(await recordOf(entry.id))
    await writeBootGraph(env)
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
    install: async (spec) => afterInstall(await installPlugin(env, spec)),
    installLocal: async (sourceDir) => afterInstall(await installLocalPlugin(env, sourceDir)),
    uninstall: async (id) => {
      const record = await recordOf(id)
      if (record.builtin) throw new Error(`PLUGIN_BUILTIN: ${record.name} can only be disabled`)
      await unloadEntry(id)
      await uninstallPlugin(env, id)
      await writeBootGraph(env)
    },
    enable: async (id) => {
      await loadRecord(await setPluginEnabled(env, id, true))
      await writeBootGraph(env)
    },
    disable: async (id) => {
      await setPluginEnabled(env, id, false)
      await unloadEntry(id)
      await writeBootGraph(env)
    },
    bootGraph: () => buildBootGraph(env),
    loadAll: async () => {
      for (const record of await readPluginRecords(env)) await loadRecord(record)
    },
  })
}

apply.inject = inject
