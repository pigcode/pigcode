/** 校验 Pigcode 插件在 package.json 中的 pigcode 声明。 */
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
