// 负责定义会话输入区的权限、思考深度和键盘选项。

/** 输入区权限模式。 */
export type PermissionMode = "ask" | "edit" | "plan"

/** 输入区思考深度。 */
export type ThinkingDepth = "off" | "low" | "medium" | "high" | "max"

/** 纯键盘事件结果。 */
export type ComposerKeyAction = "submit" | "newline" | "ignore"

/** 输入区支持的权限模式；文案由 locale 提供。 */
export const permissionModes = ["ask", "edit", "plan"] as const satisfies readonly PermissionMode[]

/** 输入区支持的思考深度；文案由 locale 提供。 */
export const thinkingDepths = [
  "off",
  "low",
  "medium",
  "high",
  "max",
] as const satisfies readonly ThinkingDepth[]

/** 将键盘事件转换为提交、换行或忽略动作。 */
export function getComposerKeyAction(key: string, shiftKey: boolean): ComposerKeyAction {
  if (key !== "Enter") return "ignore"
  return shiftKey ? "newline" : "submit"
}
