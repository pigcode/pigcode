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

/**
 * 确认一个核心服务真的起来了。Cordis 加载条目时插件抛出的错误只记日志、不往外抛，服务缺席要到后面
 * 用到它时才变成一个看不出原因的 TypeError；这里把条目启动失败的真正原因（例如数据库备份或迁移失败、
 * 数据库比应用新）重新抛出来。
 */
export async function requireCoreService(
  ctx: Context,
  entryId: string,
  service: string,
): Promise<void> {
  if (ctx.get(service) !== undefined) return
  const fiber = ctx.loader.store[entryId]?.fiber
  try {
    // 条目还在等依赖时 await 不会结束；loader 已经 await 过，等一小会儿足够拿到已经发生的错误。
    await Promise.race([fiber?.await(), new Promise((resolve) => setTimeout(resolve, 1000))])
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`${entryId} failed to start: ${reason}`, { cause: error })
  }
  throw new Error(`${entryId} failed to start: the ${service} service is not available`)
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
