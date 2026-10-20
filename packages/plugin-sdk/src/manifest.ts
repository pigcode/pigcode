/** 校验 Pigcode 插件在 package.json 中的 pigcode 声明，并判断与当前 Host 的兼容性。 */
import semver from "semver"
import { z } from "zod"

export const pluginKindSchema = z.enum(["provider", "capability", "ui", "bundle"])

export const pluginManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    engines: z.object({ pigcode: z.string().min(1) }).optional(),
    pigcode: z.object({
      apiVersion: z.literal(1),
      kind: pluginKindSchema,
      displayName: z.string().min(1).optional(),
      host: z.string().min(1).optional(),
      client: z.string().min(1).optional(),
      inject: z.array(z.string().min(1)).default([]),
      provides: z.array(z.string().min(1)).default([]),
      contributes: z.record(z.string(), z.unknown()).default({}),
      permissions: z.array(z.string().min(1)).default([]),
    }),
  })
  .refine((value) => Boolean(value.pigcode.host || value.pigcode.client), {
    message: "plugin must declare host or client entry",
    path: ["pigcode"],
  })

export type PluginManifest = z.infer<typeof pluginManifestSchema>
export type PluginKind = z.infer<typeof pluginKindSchema>

/** 当前 Host 支持的插件 API 主版本。 */
export const CURRENT_PLUGIN_API_VERSION = 1

/** Host 版本；随 Host 发布递增，插件 engines 用它判断兼容。 */
export const HOST_VERSION = "0.1.0"

/** 返回 null 表示兼容；否则返回可直接展示给用户的原因。 */
export function checkPluginCompatibility(manifest: PluginManifest): string | null {
  if (manifest.pigcode.apiVersion !== CURRENT_PLUGIN_API_VERSION) {
    return `unsupported plugin apiVersion: ${manifest.pigcode.apiVersion} (expected ${CURRENT_PLUGIN_API_VERSION})`
  }
  const range = manifest.engines?.pigcode
  if (range && !semver.satisfies(HOST_VERSION, range)) {
    return `unsupported engines.pigcode: plugin requires pigcode ${range}, current ${HOST_VERSION}`
  }
  return null
}
