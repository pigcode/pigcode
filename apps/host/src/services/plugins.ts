/** 把 plugin manager 暴露为 Host 服务，供 RPC 与界面调用。 */
import type { Context } from "cordis"
import { buildBootGraph, installLocalPlugin, setPluginEnabled } from "./plugin-manager"

/** Host 侧插件管理服务；M0 只接受本地目录安装。 */
export interface PluginsService {
  installLocal(profileDir: string, sourceDir: string): Promise<unknown>
  enable(profileDir: string, id: string): Promise<void>
  disable(profileDir: string, id: string): Promise<void>
  bootGraph(profileDir: string): Promise<unknown>
}

declare module "cordis" {
  interface Context {
    plugins: PluginsService
  }
}

/** 注册 plugins 服务，所有操作都落盘到 profile。 */
export function apply(ctx: Context): void {
  ctx.provide("plugins", {
    installLocal: installLocalPlugin,
    enable: (profileDir, id) => setPluginEnabled(profileDir, id, true),
    disable: (profileDir, id) => setPluginEnabled(profileDir, id, false),
    bootGraph: buildBootGraph,
  })
}
