// 负责定义会话输入区的权限、思考深度、模型选择和键盘选项。
import type { PermissionMode, ReasoningEffort } from "@pigcode/contracts"
import type { MessageKey } from "@pigcode/ui-primitives"

export type { PermissionMode, ReasoningEffort }

/** 纯键盘事件结果。 */
export type ComposerKeyAction = "submit" | "newline" | "ignore"

/** 权限菜单里的顺序；完全访问放在最后，选中前需要确认。 */
export const permissionModes = [
  "workspace-write",
  "plan",
  "read-only",
  "danger-full-access",
] as const satisfies readonly PermissionMode[]

/** ⇧Tab 轮换的权限；完全访问不参与轮换，只能从菜单里显式开启。 */
export const cyclePermissionModes = [
  "workspace-write",
  "plan",
  "read-only",
] as const satisfies readonly PermissionMode[]

/** 权限模式的文案。 */
export const permissionKeys: Record<
  PermissionMode,
  { label: MessageKey; description: MessageKey }
> = {
  "workspace-write": {
    label: "composer.permission.ask",
    description: "composer.permission.ask.description",
  },
  plan: { label: "composer.permission.plan", description: "composer.permission.plan.description" },
  "read-only": {
    label: "composer.permission.readOnly",
    description: "composer.permission.readOnly.description",
  },
  "danger-full-access": {
    label: "composer.permission.full",
    description: "composer.permission.full.description",
  },
}

/** 思考深度的文案；各 agent 只展示自己模型支持的档位。 */
export const effortKeys: Record<ReasoningEffort, MessageKey> = {
  minimal: "composer.effort.minimal",
  low: "composer.effort.low",
  medium: "composer.effort.medium",
  high: "composer.effort.high",
  xhigh: "composer.effort.xhigh",
  max: "composer.effort.max",
}

/** 将键盘事件转换为提交、换行或忽略动作。 */
export function getComposerKeyAction(key: string, shiftKey: boolean): ComposerKeyAction {
  if (key !== "Enter") return "ignore"
  return shiftKey ? "newline" : "submit"
}

/** 轮换到下一个权限；当前是不在轮换里的模式（完全访问）时回到默认。 */
export function nextPermissionMode(
  current: PermissionMode,
  available: readonly PermissionMode[],
): PermissionMode {
  const cycle = cyclePermissionModes.filter((mode) => available.includes(mode))
  const index = cycle.indexOf(current as (typeof cyclePermissionModes)[number])
  return cycle[(index + 1) % cycle.length] ?? "workspace-write"
}

/** 输入框里可选的一个 agent。 */
export interface ComposerAgent {
  id: string
  label: string
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
  defaultEffort: ReasoningEffort | null
  /** 用户在 agent 设置里添加的模型。 */
  custom?: boolean | undefined
}

/** 各 agent 的模型目录；undefined 表示还没读取。 */
export type ComposerModelCatalog = Readonly<Record<string, readonly ComposerModel[] | undefined>>

/** 当前实际使用的模型：线程记录的模型，否则目录里的默认模型，再否则第一个。 */
export function resolveModel(
  models: readonly ComposerModel[] | undefined,
  modelId: string | null | undefined,
): ComposerModel | null {
  if (!models || models.length === 0) return null
  return (
    models.find((model) => model.id === modelId) ??
    models.find((model) => model.isDefault) ??
    models[0] ??
    null
  )
}

/** 实际生效的思考深度：用户为该模型选过的档位，否则模型默认；模型不可调时为 null。 */
export function resolveEffort(
  model: ComposerModel | null,
  preferred: ReasoningEffort | null | undefined,
): ReasoningEffort | null {
  if (!model || model.efforts.length === 0) return null
  if (preferred && model.efforts.includes(preferred)) return preferred
  return model.defaultEffort
}
