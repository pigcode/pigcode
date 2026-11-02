/**
 * Agent（由 Agent 插件接入）的设置字段、检测状态与设置页摘要；Host、插件与界面共用。
 * 设置字段由插件在 manifest 的 `contributes.agent.settings` 里声明，界面据此生成表单，
 * Host 原样保存用户填的值，并在检测、读取模型目录和创建会话时交给 driver。
 */
import { z } from "zod"
import { agentFeaturesSchema } from "./domain"

/** 自定义模型的键：Host 把这里的模型 id 追加到 agent 的模型目录。 */
export const CUSTOM_MODELS_KEY = "customModels"

/** 可本地化的文案：一段文字，或按 locale（`zh-CN`、`en-US`、`en`…）给出的多段文字。 */
export const localizedTextSchema = z.union([
  z.string().min(1),
  z.record(z.string().min(1), z.string().min(1)),
])

/** 设置键名；`customModels` 由 Host 统一处理，插件不能占用。 */
const settingKeySchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/)
  .refine((key) => key !== CUSTOM_MODELS_KEY, { message: "customModels is reserved" })

const fieldBase = {
  key: settingKeySchema,
  label: localizedTextSchema,
  description: localizedTextSchema.optional(),
}

/**
 * 一个设置字段。值的类型：text/path/select 为字符串，boolean 为布尔，env 为
 * `{ name, value }` 数组。字段都是可选的：留空表示用 agent 自己的默认值。
 */
export const agentSettingFieldSchema = z.discriminatedUnion("type", [
  z.object({
    ...fieldBase,
    type: z.literal("text"),
    placeholder: localizedTextSchema.optional(),
    /** 等宽字体显示，适合启动参数这类命令行内容。 */
    monospace: z.boolean().optional(),
  }),
  z.object({
    ...fieldBase,
    type: z.literal("path"),
    placeholder: localizedTextSchema.optional(),
    /** 「选择…」按钮打开文件还是文件夹选择框。 */
    pathKind: z.enum(["file", "directory"]).default("file"),
  }),
  z.object({ ...fieldBase, type: z.literal("boolean"), default: z.boolean().optional() }),
  z.object({
    ...fieldBase,
    type: z.literal("select"),
    options: z.array(z.object({ value: z.string(), label: localizedTextSchema })).min(1),
    default: z.string().optional(),
  }),
  z.object({ ...fieldBase, type: z.literal("env") }),
])

/** 一组环境变量；名称遵循 POSIX 规则，值原样传给子进程。 */
export const environmentEntriesSchema = z.array(
  z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string() }),
)

/** 自定义模型列表：去掉首尾空白后的非空 id，最长 256 个字符。 */
export const customModelsSchema = z.array(z.string().trim().min(1).max(256))

/** Agent 插件在 manifest 里声明的贡献：agent id、介绍与设置字段。 */
export const agentContributionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9._-]*$/),
    description: localizedTextSchema.optional(),
    /** 桌面端只用系统浏览器打开 https 链接。 */
    homepage: z.url({ protocol: /^https$/ }).optional(),
    /** 没装 CLI 时给用户的安装提示，例如安装命令。 */
    installHint: localizedTextSchema.optional(),
    settings: z.array(agentSettingFieldSchema).default([]),
    /** 是否允许用户添加自定义模型 id；默认允许。 */
    customModels: z.boolean().default(true),
  })
  .superRefine((value, context) => {
    const seen = new Set<string>()
    for (const [index, field] of value.settings.entries()) {
      if (seen.has(field.key)) {
        context.addIssue({
          code: "custom",
          message: `duplicate setting key: ${field.key}`,
          path: ["settings", index, "key"],
        })
      }
      seen.add(field.key)
    }
  })

/** agent 的设置值：键为字段 key，另加 Host 处理的 customModels。 */
export const agentSettingsValuesSchema = z.record(z.string(), z.unknown())

/** 一次只读检测的结果；authenticated 为 null 表示无法判断登录状态。 */
export const agentStatusSchema = z.object({
  installed: z.boolean(),
  version: z.string().nullable(),
  authenticated: z.boolean().nullable(),
  /** 登录方式、订阅等补充说明，例如「Max · claude.ai」。 */
  account: z.string().nullable().optional(),
  /** 实际使用的可执行文件。 */
  command: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
})

/** 设置页里的一个 agent：插件信息、Agent 功能、设置字段与当前值。 */
export const agentSummarySchema = z.object({
  agentId: z.string().min(1),
  displayName: z.string().min(1),
  /** 提供它的插件；Host 自带的开发用 agent（fake）为 null。 */
  pluginId: z.string().nullable(),
  version: z.string().nullable(),
  /** 随应用内置：可以停用，不能卸载。 */
  builtin: z.boolean(),
  enabled: z.boolean(),
  /** driver 已注册；插件启用但加载失败时为 false。 */
  registered: z.boolean(),
  /** Agent 功能；driver 没注册时为 null。 */
  features: agentFeaturesSchema.nullable(),
  description: localizedTextSchema.nullable(),
  homepage: z.string().nullable(),
  installHint: localizedTextSchema.nullable(),
  fields: z.array(agentSettingFieldSchema),
  customModels: z.boolean(),
  values: agentSettingsValuesSchema,
  error: z.string().nullable(),
})

/** `agent.list` 的返回：全部 agent 与新会话默认使用的 agent。 */
export const agentListSchema = z.object({
  agents: z.array(agentSummarySchema),
  /** 用户选择的默认 agent；为 null 时 Host 自动挑选第一个可用的。 */
  defaultAgentId: z.string().nullable(),
})

export type LocalizedText = z.infer<typeof localizedTextSchema>
export type AgentSettingField = z.infer<typeof agentSettingFieldSchema>
export type AgentSettingFieldInput = z.input<typeof agentSettingFieldSchema>
export type EnvironmentEntry = z.infer<typeof environmentEntriesSchema>[number]
export type AgentContribution = z.infer<typeof agentContributionSchema>
export type AgentSettingsValues = z.infer<typeof agentSettingsValuesSchema>
export type AgentStatus = z.infer<typeof agentStatusSchema>
export type AgentSummary = z.infer<typeof agentSummarySchema>
export type AgentList = z.infer<typeof agentListSchema>

/**
 * 按 locale 取文案：完整 locale → 语言前缀 → 英文 → 第一条。
 * 插件可以只写一段文字，也可以给每种语言各写一段。
 */
export function localizeText(text: LocalizedText, locale: string): string {
  if (typeof text === "string") return text
  const language = locale.split("-")[0] ?? locale
  return text[locale] ?? text[language] ?? text["en-US"] ?? text.en ?? Object.values(text)[0] ?? ""
}
