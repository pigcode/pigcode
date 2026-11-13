// 负责定义会话输入区的权限、思考深度、模型选择和键盘选项。
import type {
  AgentExecutionModes,
  KnownReasoningEffort,
  PermissionMode,
  ReasoningEffort,
} from "@pigcode/contracts"
import type { MessageKey } from "@pigcode/ui-primitives"

export type { PermissionMode, ReasoningEffort }

/** 纯键盘事件结果。 */
export type ComposerKeyAction = "submit" | "newline" | "ignore"

/** 已知思考深度的文案；各 agent 只展示自己模型支持的档位。 */
export const effortKeys: Record<KnownReasoningEffort, MessageKey> = {
  none: "composer.effort.none",
  minimal: "composer.effort.minimal",
  low: "composer.effort.low",
  medium: "composer.effort.medium",
  high: "composer.effort.high",
  xhigh: "composer.effort.xhigh",
  max: "composer.effort.max",
  ultra: "composer.effort.ultra",
}

/**
 * 思考深度的显示名：已知档位用界面文案，模型目录里新出现的档位显示原名（下划线、连字符换成空格，首字母大写）。
 */
export function effortLabel(effort: ReasoningEffort, t: (key: MessageKey) => string): string {
  if (Object.hasOwn(effortKeys, effort)) return t(effortKeys[effort as KnownReasoningEffort])
  const words = effort.replace(/[_-]+/g, " ").trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** 将键盘事件转换为提交、换行或忽略动作。 */
export function getComposerKeyAction(key: string, shiftKey: boolean): ComposerKeyAction {
  if (key !== "Enter") return "ignore"
  return shiftKey ? "newline" : "submit"
}

export { nextPermissionMode } from "./permission-options"

/** 输入框里可选的一项：一个 Agent 实例（默认实例就是 Agent 自己）。 */
export interface ComposerAgent {
  /** 选择用的键：Agent 实例 id；默认实例等于 agent id。 */
  id: string
  /** 提供实现的 Agent（driver id）。 */
  agentId: string
  /** 显示名：实例名；默认实例用 Agent 名。 */
  label: string
  executionModes?: AgentExecutionModes | null
  /** 检测到 CLI 未安装时为 false；未知时视为可用。 */
  installed?: boolean | undefined
}

/** agent 的一个模型；efforts 为空表示该模型没有可调的思考深度。 */
export interface ComposerModel {
  id: string
  label: string
  description?: string | undefined
  isDefault: boolean
  efforts: readonly ReasoningEffort[]
  /** 用户在 agent 设置里添加的模型。 */
  custom?: boolean | undefined
  /** 用户在 agent 设置里把它从选择器里隐藏了；正在用的模型照样显示。 */
  hidden?: boolean | undefined
  /** 支持快速模式。 */
  fast?: boolean | undefined
  /** 支持 Ultracode。 */
  ultracode?: boolean | undefined
}

/** 各 agent 实例的模型目录；undefined 表示还没读取。键是实例 id。 */
export type ComposerModelCatalog = Readonly<Record<string, readonly ComposerModel[] | undefined>>

/** 在选择器里选中一个模型：实例、它属于哪个 Agent，以及模型。 */
export interface ComposerModelChoice {
  /** 实例 id；默认实例等于 agent id。 */
  instanceId: string
  /** 提供实现的 Agent。 */
  agentId: string
  modelId: string
}

/** 当前实际使用的模型：线程记录的模型，否则目录里的默认模型，再否则第一个没隐藏的。 */
export function resolveModel(
  models: readonly ComposerModel[] | undefined,
  modelId: string | null | undefined,
): ComposerModel | null {
  if (!models || models.length === 0) return null
  return (
    models.find((model) => model.id === modelId) ??
    models.find((model) => model.isDefault) ??
    models.find((model) => !model.hidden) ??
    models[0] ??
    null
  )
}

/**
 * 发送时显式指定的思考深度：用户为该模型选过、且模型支持的档位。没选过就是「默认」，返回 null：
 * 不发档位，由 agent 自己决定。目录里的默认档位也不替它发，否则会盖掉用户在 CLI 里配的档位。
 */
export function resolveEffort(
  model: ComposerModel | null,
  preferred: ReasoningEffort | null | undefined,
): ReasoningEffort | null {
  if (!model || !preferred) return null
  return model.efforts.includes(preferred) ? preferred : null
}

/** 按模型开关的模式：快速模式与 Ultracode。 */
export type ModelSwitch = "fast" | "ultracode"

/** 发送时是否打开某个开关：模型支持、并且用户为它打开过。 */
export function resolveSwitch(
  model: ComposerModel | null,
  name: ModelSwitch,
  enabled: boolean,
): boolean {
  return Boolean(model?.[name]) && enabled
}
