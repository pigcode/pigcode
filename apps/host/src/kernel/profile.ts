/** 读取 profile YAML；profile 只描述插件条目，不承载业务逻辑。 */
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parse } from "yaml"
import { z } from "zod"

/** 单个插件条目的 schema：id 为稳定标识，name 为插件入口。 */
export const profileEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  config: z.unknown().optional(),
  disabled: z.boolean().optional(),
})

/**
 * profile 文件 schema：核心服务条目按声明顺序加载；builtinPlugins 是随应用内置的插件包目录
 * （相对 profile 目录），由插件服务加载，可以停用。
 */
export const profileSchema = z.object({
  plugins: z.array(profileEntrySchema),
  builtinPlugins: z.array(z.string().min(1)).default([]),
})

/** 单个插件条目的类型。 */
export type ProfileEntry = z.infer<typeof profileEntrySchema>

/** profile 文件的类型。 */
export type Profile = z.infer<typeof profileSchema>

/** 已读取的 profile，额外携带来源目录与文件路径；builtinPlugins 已解析成绝对路径。 */
export interface LoadedProfile extends Profile {
  profileDir: string
  profilePath: string
}

/** 从 profileDir 读取 `<name>.yml` 并校验。 */
export async function loadProfile(profileDir: string, profileName: string): Promise<LoadedProfile> {
  const profilePath = join(profileDir, `${profileName}.yml`)
  const source = await readFile(profilePath, "utf8")
  const profile = profileSchema.parse(parse(source))
  return {
    ...profile,
    builtinPlugins: profile.builtinPlugins.map((dir) => resolve(profileDir, dir)),
    profileDir,
    profilePath,
  }
}
