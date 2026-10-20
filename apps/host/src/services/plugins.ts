/** 把 plugin manager 暴露为 Host 服务，供 RPC 与界面调用。 */
import type { Context } from "cordis"
import { writeBootGraph } from "../kernel/boot"
import {
  buildBootGraph,
  installLocalPlugin,
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

/** Host 侧插件管理服务；M0 只接受本地目录安装。 */
export interface PluginsService {
  list(): Promise<PluginSummary[]>
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

/** 注册 plugins 服务；写操作完成后同步刷新 boot graph。 */
export function apply(ctx: Context, config: PluginsConfig): void {
  const { profileDir } = config
  ctx.provide("plugins", {
    list: () => listPlugins(profileDir),
    installLocal: async (sourceDir) => {
      const entry = await installLocalPlugin(profileDir, sourceDir)
      await writeBootGraph(profileDir)
      return entry
    },
    enable: async (id) => {
      await setPluginEnabled(profileDir, id, true)
      await writeBootGraph(profileDir)
    },
    disable: async (id) => {
      await setPluginEnabled(profileDir, id, false)
      await writeBootGraph(profileDir)
    },
    bootGraph: () => buildBootGraph(profileDir),
  })
}
