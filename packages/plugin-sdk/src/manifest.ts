/** 校验 Pigcode 插件在 package.json 中的 pigcode 声明，并判断与当前 Host 的兼容性。 */
import semver from "semver"
import { z } from "zod"
import { agentContributionSchema, type AgentContribution } from "@pigcode/contracts"

/** 插件种类；插件 id 是 `<kind>.<包名>`。 */
export const pluginKindSchema = z.enum(["agent", "capability", "ui", "bundle"])

/**
 * Agent 插件改名前的写法（`kind: "provider"`、`contributes.provider`、`provides` 里的 `provider:<id>`）
 * 不再接受；校验错误说明改成什么，插件作者照着改就行。
 */
function renamed(from: string, to: string): string {
  return `${from} was renamed to ${to} (see docs/plugin-authoring.md)`
}

/**
 * manifest 里不再读取的贡献点：内容是代码登记的，写在 manifest 里没有任何效果。
 * 校验时直接拒绝，并指出现在该在哪里登记。
 */
const REMOVED_CONTRIBUTIONS = new Map([
  ["settings", "register the page with ctx.settingsPages.register in the client entry"],
  ["commands", "register it with ctx.commands.register in the client entry"],
  ["slots", "register it with ctx.panels, ctx.surfaces or ctx.settingsPages in the client entry"],
  ["rpc", "plugins cannot add RPC methods"],
])

/** 改名或删掉的贡献点的报错；其它键返回 null。 */
function contributionError(key: string): string | null {
  if (key === "provider") return renamed("contributes.provider", "contributes.agent")
  const hint = REMOVED_CONTRIBUTIONS.get(key)
  return hint
    ? `contributes.${key} is no longer read: ${hint} (see docs/plugin-authoring.md)`
    : null
}

export const pluginManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    engines: z.object({ pigcode: z.string().min(1) }).optional(),
    pigcode: z.object({
      // 只要求是整数：不兼容的版本也照常读出，由 checkPluginCompatibility 给出能读懂的原因。
      apiVersion: z.number().int(),
      kind: z.enum(pluginKindSchema.options, {
        error: (issue) =>
          issue.input === "provider" ? renamed('kind "provider"', '"agent"') : undefined,
      }),
      displayName: z.string().min(1).optional(),
      host: z.string().min(1).optional(),
      client: z.string().min(1).optional(),
      inject: z.array(z.string().min(1)).default([]),
      provides: z
        .array(
          z
            .string()
            .min(1)
            .refine((item) => !item.startsWith("provider:"), {
              error: (issue) =>
                renamed(
                  `provides "${String(issue.input)}"`,
                  `"agent:${String(issue.input).slice("provider:".length)}"`,
                ),
            }),
        )
        .default([]),
      contributes: z
        .record(z.string(), z.unknown())
        .superRefine((value, context) => {
          // 只拦改名和删掉的字段；manifest 里其它元数据原样保留，插件可以自己用。
          for (const key of Object.keys(value)) {
            const message = contributionError(key)
            if (message) context.addIssue({ code: "custom", message, path: [key] })
          }
        })
        .default({}),
      permissions: z.array(z.string().min(1)).default([]),
    }),
  })
  .refine((value) => Boolean(value.pigcode.host || value.pigcode.client), {
    message: "plugin must declare host or client entry",
    path: ["pigcode"],
  })
  .superRefine((value, context) => {
    // agent 的设置表单由这份贡献生成，声明不合法时安装阶段就拒绝。
    const contribution = value.pigcode.contributes.agent
    if (contribution === undefined) return
    const parsed = agentContributionSchema.safeParse(contribution)
    if (parsed.success) return
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: ["pigcode", "contributes", "agent", ...issue.path.map(String)],
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
    // 同时写出插件需要的版本和 Host 支持的版本，插件作者据此决定改插件还是升级 Host。
    return `unsupported plugin apiVersion: ${manifest.pigcode.apiVersion}; this Host supports ${CURRENT_PLUGIN_API_VERSION}`
  }
  const range = manifest.engines?.pigcode
  if (range && !semver.satisfies(HOST_VERSION, range)) {
    return `unsupported engines.pigcode: plugin requires pigcode ${range}, current ${HOST_VERSION}`
  }
  return null
}

/** 是不是接入 Agent 的插件。 */
export function isAgentPlugin(manifest: { pigcode: { kind: string } }): boolean {
  return manifest.pigcode.kind === "agent"
}

/**
 * Agent 插件贡献的 agent：优先读 `contributes.agent`，没有时从 `provides` 里的 `agent:<id>`
 * 推断出只有 id 的贡献；都没有时返回 null。
 */
export function readAgentContribution(manifest: PluginManifest): AgentContribution | null {
  const { contributes, provides } = manifest.pigcode
  const declared = agentContributionSchema.safeParse(contributes.agent)
  if (declared.success) return declared.data
  const provided = provides.find((item) => item.startsWith("agent:"))
  const id = provided?.slice("agent:".length)
  if (!id) return null
  const inferred = agentContributionSchema.safeParse({ id })
  return inferred.success ? inferred.data : null
}

/**
 * 校验 manifest；不合法时抛出的 Error 逐条列出原因（`路径: 说明`），插件管理界面直接展示，
 * 不展示 zod 的原始 JSON。
 */
export function parsePluginManifest(raw: unknown): PluginManifest {
  const result = pluginManifestSchema.safeParse(raw)
  if (result.success) return result.data
  const reasons = result.error.issues.map((issue) =>
    issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
  )
  throw new Error(`invalid plugin manifest: ${reasons.join("; ")}`)
}
