/** 创建 Host Cordis 插件树；profile 负责组合，kernel 只做启动和 teardown。 */
import { Context } from "cordis"
import Loader, { type EntryOptions } from "@cordisjs/plugin-loader"
import { pathToFileURL } from "node:url"
import { loadProfile, type LoadedProfile } from "./profile"

/** 创建 Host kernel 所需的 profile 位置。 */
export interface CreateHostAppOptions {
  profileDir: string
  profileName: string
  /** 按条目 id 替换 config，例如把 storage 指到用户目录里的数据库。 */
  configOverrides?: Record<string, unknown>
}

/** `--dump-config` 输出中的单条插件配置。 */
export interface DumpedConfigEntry {
  id: string
  name: string
  config?: unknown
  disabled: boolean
}

/** `--dump-config` 的完整输出结构。 */
export interface DumpedConfig {
  entries: DumpedConfigEntry[]
}

/** loader 创建条目时使用的选项；运行时会保留显式传入的 id。 */
type LoaderCreateOptions = Omit<EntryOptions, "id"> & { id?: string }

/** 按 profile 加载核心服务；条目的相对入口以 profile 目录为基准解析。 */
export async function createHostAppFromProfile(
  profile: LoadedProfile,
  configOverrides: Record<string, unknown> = {},
): Promise<Context> {
  const ctx = new Context()
  const base = pathToFileURL(profile.profileDir).href
  const baseUrl = base.endsWith("/") ? base : `${base}/`
  await ctx.plugin(Loader, { baseUrl })

  for (const entry of profile.plugins) {
    const config = entry.id in configOverrides ? configOverrides[entry.id] : entry.config
    const createOptions: LoaderCreateOptions = {
      id: entry.id,
      name: entry.name,
      ...(config === undefined ? {} : { config }),
      ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
    }
    await ctx.loader.create(createOptions)
  }
  await ctx.loader.await()
  return ctx
}

/** 读取 profile 并创建 kernel。 */
export async function createHostApp(options: CreateHostAppOptions): Promise<Context> {
  const profile = await loadProfile(options.profileDir, options.profileName)
  return createHostAppFromProfile(profile, options.configOverrides)
}

/** 输出 loader 当前条目，供 `pigcode --dump-config` 使用。 */
export function dumpConfig(ctx: Context): DumpedConfig {
  const entries = Object.values(ctx.loader.store).map((entry) => ({
    id: entry.options.id,
    name: entry.options.name,
    config: entry.options.config,
    disabled: Boolean(entry.options.disabled),
  }))
  return { entries }
}
