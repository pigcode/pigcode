/**
 * 页面里还有没保存的文件修改时，关闭、退出或刷新窗口会被页面拦下（beforeunload）；
 * 主进程在 will-prevent-unload 里弹确认框，用户选择放弃修改才继续。
 */
import type { MessageBoxSyncOptions } from "electron"

/** 确认框的文案；由页面按当前语言传入。 */
export interface UnsavedGuardLabels {
  message: string
  detail: string
  discard: string
  cancel: string
}

/** 页面还没传文案时使用。 */
export const DEFAULT_UNSAVED_LABELS: UnsavedGuardLabels = {
  message: "Discard unsaved changes?",
  detail: "Some files have unsaved changes. They will be lost if you close or reload the window.",
  discard: "Discard",
  cancel: "Keep editing",
}

const MAX_LABEL = 200
const KEYS = ["message", "detail", "discard", "cancel"] as const

/** 校验页面传来的文案；缺字段或不是短文本时整份丢弃。 */
export function readUnsavedGuardLabels(value: unknown): UnsavedGuardLabels | null {
  if (typeof value !== "object" || value === null) return null
  const record = value as Record<string, unknown>
  const labels: Partial<UnsavedGuardLabels> = {}
  for (const key of KEYS) {
    const text = record[key]
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_LABEL) return null
    labels[key] = text
  }
  return labels as UnsavedGuardLabels
}

/** 弹出同步确认框；返回 true 表示放弃修改、继续关闭或刷新。默认按钮是「继续编辑」。 */
export function confirmDiscard(
  showMessageBox: (options: MessageBoxSyncOptions) => number,
  labels: UnsavedGuardLabels,
): boolean {
  const choice = showMessageBox({
    type: "warning",
    buttons: [labels.discard, labels.cancel],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: labels.message,
    detail: labels.detail,
  })
  return choice === 0
}
