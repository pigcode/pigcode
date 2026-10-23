/** 校验 Pigcode 插件在 package.json 中的 pigcode 声明，并判断与当前 Host 的兼容性。 */
import semver from "semver"
import { z } from "zod"
import { providerContributionSchema, type ProviderContribution } from "@pigcode/contracts"

export const pluginKindSchema = z.enum(["provider", "capability", "ui", "bundle"])

export const pluginManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
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
  .superRefine((value, context) => {
    // agent 的设置表单由 contributes.provider 生成，声明不合法时安装阶段就拒绝。
    const provider = value.pigcode.contributes.provider
    if (provider === undefined) return
    const parsed = providerContributionSchema.safeParse(provider)
    if (parsed.success) return
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: ["pigcode", "contributes", "provider", ...issue.path.map(String)],
      })
    }
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

/**
 * provider 插件贡献的 agent：优先读 `contributes.provider`，没有时从 `provides` 里的
 * `provider:<id>` 推断出只有 id 的贡献；都没有时返回 null。
 */
export function readProviderContribution(manifest: PluginManifest): ProviderContribution | null {
  const declared = providerContributionSchema.safeParse(manifest.pigcode.contributes.provider)
  if (declared.success) return declared.data
  const provided = manifest.pigcode.provides.find((item) => item.startsWith("provider:"))
  const id = provided?.slice("provider:".length)
  if (!id) return null
  const inferred = providerContributionSchema.safeParse({ id })
  return inferred.success ? inferred.data : null
}
