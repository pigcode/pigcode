/** 「源文件夹」的系统选择框：用系统自带的文件管理器挑一个文件夹。 */
import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from "electron"

/** 选择框的标题与确认按钮文案；由页面按当前语言传入。 */
export interface FolderPickerLabels {
  title?: string
  buttonLabel?: string
}

const MAX_LABEL = 80

/** 校验页面传来的文案；不合法的字段直接丢弃，选择框照常打开。 */
export function readFolderPickerLabels(value: unknown): FolderPickerLabels {
  if (typeof value !== "object" || value === null) return {}
  const record = value as Record<string, unknown>
  const labels: FolderPickerLabels = {}
  for (const key of ["title", "buttonLabel"] as const) {
    const text = record[key]
    if (typeof text === "string" && text.length > 0 && text.length <= MAX_LABEL) labels[key] = text
  }
  return labels
}

/** 弹出系统选择框的 Electron 接口；测试里可以替换。 */
export type ShowOpenDialog = (
  window: BrowserWindow,
  options: OpenDialogOptions,
) => Promise<OpenDialogReturnValue>

/** 以窗口为父弹出系统文件夹选择框；取消时返回 null。 */
export async function pickFolder(
  showOpenDialog: ShowOpenDialog,
  window: BrowserWindow,
  labels: FolderPickerLabels,
): Promise<string | null> {
  const result = await showOpenDialog(window, {
    properties: ["openDirectory", "createDirectory"],
    ...labels,
  })
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

/** agent 设置里的路径选择：可执行文件或配置目录；只接受这两种。 */
export function readPathKind(value: unknown): "file" | "directory" | null {
  return value === "file" || value === "directory" ? value : null
}

/**
 * 选择一个文件或文件夹，用于 agent 的可执行文件与配置目录。
 * 显示隐藏文件：~/.claude、~/.codex 这类配置目录默认是隐藏的。
 */
export async function pickPath(
  showOpenDialog: ShowOpenDialog,
  window: BrowserWindow,
  kind: "file" | "directory",
  labels: FolderPickerLabels,
): Promise<string | null> {
  const result = await showOpenDialog(window, {
    properties: [kind === "file" ? "openFile" : "openDirectory", "showHiddenFiles"],
    ...labels,
  })
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

/** 只允许打开不带凭据的 https 链接，例如 agent 的官网。 */
export function readExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}
