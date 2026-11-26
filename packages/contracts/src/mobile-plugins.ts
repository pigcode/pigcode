/** 手机端插件与插件市场管理协议：脱敏本机路径、原始贡献点与内联 data 图标，严格收口操作边界。 */
import { z } from "zod"

export const MOBILE_MARKETPLACE_ICON_MAX_LENGTH = 512

export const mobilePluginMethods = {
  list: "mobile.plugin.list",
  setEnabled: "mobile.plugin.setEnabled",
  update: "mobile.plugin.update",
  uninstall: "mobile.plugin.uninstall",
  marketplaces: "mobile.plugin.marketplaces",
  refreshMarketplaces: "mobile.plugin.refreshMarketplaces",
  installFromMarketplace: "mobile.plugin.installFromMarketplace",
} as const

const idSchema = z.string().min(1)

export const mobilePluginKindSchema = z.enum(["agent", "capability", "ui", "bundle"])
export const mobilePluginOriginKindSchema = z.enum([
  "builtin",
  "marketplace",
  "npm",
  "github",
  "git",
  "url",
  "local",
])

/** 脱敏后的已安装/内置插件摘要：不暴露 contributes 与原始本机路径。 */
export const mobilePluginSummarySchema = z
  .object({
    id: idSchema,
    name: idSchema,
    displayName: idSchema,
    description: z.string().nullable(),
    version: z.string(),
    kind: mobilePluginKindSchema,
    enabled: z.boolean(),
    builtin: z.boolean(),
    apiVersion: z.number().int().nonnegative(),
    permissions: z.array(z.string()),
    provides: z.array(z.string()),
    conflict: z.string().nullable(),
    error: z.string().nullable(),
    originKind: mobilePluginOriginKindSchema.nullable(),
    marketplaceId: z.string().nullable(),
    marketplacePluginName: z.string().nullable(),
    originLabel: z.string().nullable(),
    canUpdate: z.boolean(),
  })
  .strict()

export const mobilePluginListParamsSchema = z.object({}).strict()
export const mobilePluginListResultSchema = z
  .object({
    plugins: z.array(mobilePluginSummarySchema),
    truncated: z.boolean(),
  })
  .strict()

export const mobilePluginSetEnabledParamsSchema = z
  .object({
    id: idSchema,
    enabled: z.boolean(),
  })
  .strict()

export const mobilePluginIdParamsSchema = z
  .object({
    id: idSchema,
  })
  .strict()

export const mobilePluginMutationResultSchema = z
  .object({
    plugin: mobilePluginSummarySchema,
  })
  .strict()

export const mobilePluginUninstallResultSchema = z
  .object({
    uninstalled: z.literal(true),
  })
  .strict()

export const mobileMarketplaceSourceTypeSchema = z.enum([
  "github",
  "git",
  "url",
  "directory",
  "file",
])

export const mobileMarketplacePublisherTypeSchema = z.enum(["official", "community"])

export const mobileMarketplacePluginSchema = z
  .object({
    name: idSchema,
    displayName: z.string().nullable(),
    description: z.string().nullable(),
    version: z.string().nullable(),
    category: z.string().nullable(),
    iconUrl: z
      .string()
      .max(MOBILE_MARKETPLACE_ICON_MAX_LENGTH)
      .regex(/^https:\/\//)
      .nullable(),
    homepage: z.string().nullable(),
    author: z.string().nullable(),
    publisherType: mobileMarketplacePublisherTypeSchema.nullable(),
    displayNameI18n: z.record(z.string(), z.string()).optional(),
    descriptionI18n: z.record(z.string(), z.string()).optional(),
    sourceLabel: z.string(),
  })
  .strict()

/** 脱敏后的插件市场摘要：不传 sourcePath，本地市场来源文案由 Host 脱敏。 */
export const mobileMarketplaceSummarySchema = z
  .object({
    id: idSchema,
    official: z.boolean(),
    displayName: idSchema,
    description: z.string().nullable(),
    owner: z.string().nullable(),
    sourceType: mobileMarketplaceSourceTypeSchema,
    sourceLabel: z.string(),
    sourceUrl: z.string().nullable(),
    enabled: z.boolean(),
    lastUpdated: z.string().nullable(),
    error: z.string().nullable(),
    plugins: z.array(mobileMarketplacePluginSchema),
  })
  .strict()

export const mobilePluginMarketplacesParamsSchema = z.object({}).strict()
export const mobilePluginMarketplacesResultSchema = z
  .object({
    marketplaces: z.array(mobileMarketplaceSummarySchema),
    truncated: z.boolean(),
  })
  .strict()

export const mobilePluginRefreshMarketplacesParamsSchema = z
  .object({
    id: idSchema.optional(),
    ifStale: z.boolean().optional(),
  })
  .strict()

export const mobilePluginInstallFromMarketplaceParamsSchema = z
  .object({
    marketplace: idSchema,
    name: idSchema,
  })
  .strict()

export type MobilePluginMethod = (typeof mobilePluginMethods)[keyof typeof mobilePluginMethods]
export type MobilePluginKind = z.infer<typeof mobilePluginKindSchema>
export type MobilePluginOriginKind = z.infer<typeof mobilePluginOriginKindSchema>
export type MobilePluginSummary = z.infer<typeof mobilePluginSummarySchema>
export type MobilePluginListParams = z.infer<typeof mobilePluginListParamsSchema>
export type MobilePluginListResult = z.infer<typeof mobilePluginListResultSchema>
export type MobilePluginSetEnabledParams = z.infer<typeof mobilePluginSetEnabledParamsSchema>
export type MobilePluginIdParams = z.infer<typeof mobilePluginIdParamsSchema>
export type MobilePluginMutationResult = z.infer<typeof mobilePluginMutationResultSchema>
export type MobilePluginUninstallResult = z.infer<typeof mobilePluginUninstallResultSchema>
export type MobileMarketplaceSourceType = z.infer<typeof mobileMarketplaceSourceTypeSchema>
export type MobileMarketplacePublisherType = z.infer<typeof mobileMarketplacePublisherTypeSchema>
export type MobileMarketplacePlugin = z.infer<typeof mobileMarketplacePluginSchema>
export type MobileMarketplaceSummary = z.infer<typeof mobileMarketplaceSummarySchema>
export type MobilePluginMarketplacesParams = z.infer<typeof mobilePluginMarketplacesParamsSchema>
export type MobilePluginMarketplacesResult = z.infer<typeof mobilePluginMarketplacesResultSchema>
export type MobilePluginRefreshMarketplacesParams = z.infer<
  typeof mobilePluginRefreshMarketplacesParamsSchema
>
export type MobilePluginInstallFromMarketplaceParams = z.infer<
  typeof mobilePluginInstallFromMarketplaceParamsSchema
>
