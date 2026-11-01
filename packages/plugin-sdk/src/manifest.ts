/** 校验 Pigcode 插件在 package.json 中的 pigcode 声明，并判断与当前 Host 的兼容性。 */
import semver from "semver"
import { z } from "zod"
import { agentContributionSchema, type AgentContribution } from "@pigcode/contracts"

/** 解析后的插件种类；manifest 里写的 `agent` 解析成 `provider`，插件 id 与已保存的数据不变。 */
export const pluginKindSchema = z.enum(["provider", "capability", "ui", "bundle"])

/**
 * 一个 manifest 只能用一套名字：新名字（`kind: "agent"`、`contributes.agent`、`provides` 里的
 * `agent:<id>`）或旧名字（`provider`）。两套混用时返回用到的写法，否则返回 null。
 */
function mixedAgentNames(pigcode: {
  kind: string
  provides: string[]
  contributes: Record<string, unknown>
}): { agent: string[]; provider: string[] } | null {
  const used = (name: "agent" | "provider") => [
    ...(pigcode.kind === name ? [`kind "${name}"`] : []),
    ...(pigcode.contributes[name] !== undefined ? [`contributes.${name}`] : []),
    ...pigcode.provides
      .filter((item) => item.startsWith(`${name}:`))
      .map((item) => `provides "${item}"`),
  ]
  const agent = used("agent")
  const provider = used("provider")
  return agent.length > 0 && provider.length > 0 ? { agent, provider } : null
}

export const pluginManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().optional(),
    engines: z.object({ pigcode: z.string().min(1) }).optional(),
    pigcode: z.object({
      apiVersion: z.literal(1),
      kind: z.enum([...pluginKindSchema.options, "agent"]),
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
    const mixed = mixedAgentNames(value.pigcode)
    if (mixed) {
      context.addIssue({
        code: "custom",
        message: `use either the agent names or the old provider names, not both: found ${mixed.agent.join(", ")} and ${mixed.provider.join(", ")}`,
        path: ["pigcode"],
      })
      return
    }
    // agent 的设置表单由这份贡献生成，声明不合法时安装阶段就拒绝。
    const key = value.pigcode.contributes.agent === undefined ? "provider" : "agent"
    const contribution = value.pigcode.contributes[key]
    if (contribution === undefined) return
    const parsed = agentContributionSchema.safeParse(contribution)
    if (parsed.success) return
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        message: issue.message,
        path: ["pigcode", "contributes", key, ...issue.path.map(String)],
      })
    }
  })
  // 新名字解析成旧名字：下游代码拿到的结果和写旧名字时完全一样。
  .transform(({ pigcode, ...rest }) => {
    const { agent, ...contributes } = pigcode.contributes
    return {
      ...rest,
      pigcode: {
        ...pigcode,
        kind: pigcode.kind === "agent" ? "provider" : pigcode.kind,
        provides: pigcode.provides.map((item) =>
          item.startsWith("agent:") ? `provider:${item.slice("agent:".length)}` : item,
        ),
        contributes: agent === undefined ? contributes : { ...contributes, provider: agent },
      },
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

/** 是不是接入 Agent 的插件；`kind` 写 `agent` 或旧名字 `provider` 都算。 */
export function isAgentPlugin(manifest: { pigcode: { kind: string } }): boolean {
  return manifest.pigcode.kind === "agent" || manifest.pigcode.kind === "provider"
}

/**
 * Agent 插件贡献的 agent：优先读 `contributes.agent`（旧名 `contributes.provider`），没有时从
 * `provides` 里的 `agent:<id>`（旧名 `provider:<id>`）推断出只有 id 的贡献；都没有时返回 null。
 */
export function readAgentContribution(manifest: PluginManifest): AgentContribution | null {
  const { contributes, provides } = manifest.pigcode
  const declared = agentContributionSchema.safeParse(contributes.agent ?? contributes.provider)
  if (declared.success) return declared.data
  const provided = provides.find(
    (item) => item.startsWith("agent:") || item.startsWith("provider:"),
  )
  const id = provided?.slice(provided.indexOf(":") + 1)
  if (!id) return null
  const inferred = agentContributionSchema.safeParse({ id })
  return inferred.success ? inferred.data : null
}

/** @deprecated use readAgentContribution */
export const readProviderContribution = readAgentContribution
