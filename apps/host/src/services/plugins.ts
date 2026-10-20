/** 把 plugin manager 暴露为 Host 服务，供 RPC 与界面调用。 */
import type { EntryOptions } from "@cordisjs/plugin-loader"
import {
  checkPluginCompatibility,
  pluginManifestSchema,
  type PluginManifest,
} from "@pigcode/plugin-sdk"
import type { Context } from "cordis"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { writeBootGraph } from "../kernel/boot"
import {
  buildBootGraph,
  installLocalPlugin,
  installPlugin,
  listPlugins,
  setPluginEnabled,
  type BootGraphEntry,
  type InstalledPluginEntry,
  type PluginSummary,
} from "./plugin-manager"

/** plugins 插件的配置；profileDir 决定所有操作的落盘位置。 */
export interface PluginsConfig {
  profileDir: string
}

/** Host 侧插件管理服务；支持本地目录、npm 包名/版本与 tarball 安装。 */
export interface PluginsService {
  list(): Promise<PluginSummary[]>
  install(spec: string): Promise<InstalledPluginEntry>
  installLocal(sourceDir: string): Promise<InstalledPluginEntry>
  enable(id: string): Promise<void>
  disable(id: string): Promise<void>
  bootGraph(): Promise<{ entries: BootGraphEntry[] }>
}

declare module "cordis" {
  interface Context {
    plugins: PluginsService
  }
}

/** loader 创建条目时使用的选项；运行时会保留显式传入的 id。 */
type LoaderCreateOptions = Omit<EntryOptions, "id"> & { id?: string }

/** 从已安装目录读取 manifest；文件缺失或格式非法时返回 null。 */
async function readInstalledManifest(
  profileDir: string,
  entry: InstalledPluginEntry,
): Promise<PluginManifest | null> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(profileDir, "node_modules", entry.name, "package.json"), "utf8"),
    )
    return pluginManifestSchema.parse(raw)
  } catch {
    return null
  }
}

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
  const { profileDir } = config
  // 加载失败只记录在内存里，供 list 合并展示；重启后由 loader 重新尝试。
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

  /** 按 profile 条目创建 loader 条目；非 Host 插件与不兼容插件跳过。 */
  async function loadEntry(entry: InstalledPluginEntry): Promise<void> {
    const manifest = await readInstalledManifest(profileDir, entry)
    if (!manifest?.pigcode.host) return
    const incompatible = checkPluginCompatibility(manifest)
    if (incompatible) {
      loadErrors.set(entry.id, incompatible)
      return
    }
    const existing = ctx.loader.store[entry.id]
    if (existing) {
      // 启动时 disabled 的条目已在 loader 中但没有 fiber；这里重新激活。
      if (existing.fiber) return
      await ctx.loader.update(entry.id, { disabled: false })
      await ctx.loader.await()
      await settleEntry(entry.id, entry.name)
      return
    }
    const options: LoaderCreateOptions = {
      id: entry.id,
      name: entry.name,
      config: entry.config ?? {},
    }
    try {
      await ctx.loader.create(options)
      await ctx.loader.await()
      await settleEntry(entry.id, entry.name)
    } catch (error) {
      loadErrors.set(entry.id, `plugin failed to load: ${errorMessage(error)}`)
    }
  }

  /** 移除 loader 条目，并等待插件 effect 清理完成。 */
  async function unloadEntry(id: string): Promise<void> {
    const entry = ctx.loader.store[id]
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
    loadErrors.delete(id)
  }

  ctx.provide("plugins", {
    list: async () => {
      const summaries = await listPlugins(profileDir)
      return summaries.map((summary) => {
        const loadError = loadErrors.get(summary.id)
        // manifest 错误优先；加载错误只在没有其他错误时展示。
        return loadError && !summary.error ? { ...summary, error: loadError } : summary
      })
    },
    install: async (spec) => {
      const entry = await installPlugin(profileDir, spec)
      await loadEntry(entry)
      await writeBootGraph(profileDir)
      return entry
    },
    installLocal: async (sourceDir) => {
      const entry = await installLocalPlugin(profileDir, sourceDir)
      await loadEntry(entry)
      await writeBootGraph(profileDir)
      return entry
    },
    enable: async (id) => {
      const entry = await setPluginEnabled(profileDir, id, true)
      await loadEntry(entry)
      await writeBootGraph(profileDir)
    },
    disable: async (id) => {
      await setPluginEnabled(profileDir, id, false)
      await unloadEntry(id)
      await writeBootGraph(profileDir)
    },
    bootGraph: () => buildBootGraph(profileDir),
  })
}

apply.inject = inject
