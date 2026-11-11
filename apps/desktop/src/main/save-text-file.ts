/** 把页面给的一段文本存成文件（导出主题用）：主进程弹系统的保存对话框，用户选了位置才写。 */
import { writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import type { BrowserWindow, SaveDialogOptions, SaveDialogReturnValue } from "electron"

/** 一次最多写 1 MB；主题文件只有几百字节，超出说明调用方传错了东西。 */
export const MAX_TEXT_FILE_BYTES = 1024 * 1024

/** 校验页面传来的文件名和内容：文件名只取最后一段，不允许带目录；不合法时返回 null。 */
export function readTextFileRequest(
  fileName: unknown,
  text: unknown,
): { fileName: string; text: string } | null {
  if (typeof fileName !== "string" || typeof text !== "string") return null
  const name = basename(fileName.replace(/\\/g, "/")).trim()
  if (!name || name === "." || name === "..") return null
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_FILE_BYTES) return null
  return { fileName: name, text }
}

type ShowSaveDialog = (
  parent: BrowserWindow,
  options: SaveDialogOptions,
) => Promise<SaveDialogReturnValue>

/** 弹保存对话框（默认放在下载目录），确认后写入；取消时返回 false。 */
export async function saveTextFile(
  showSaveDialog: ShowSaveDialog,
  window: BrowserWindow,
  directory: string,
  request: { fileName: string; text: string },
): Promise<boolean> {
  const extension = request.fileName.includes(".") ? request.fileName.split(".").pop() : undefined
  const result = await showSaveDialog(window, {
    defaultPath: join(directory, request.fileName),
    ...(extension ? { filters: [{ name: extension.toUpperCase(), extensions: [extension] }] } : {}),
  })
  if (result.canceled || !result.filePath) return false
  await writeFile(result.filePath, request.text, "utf8")
  return true
}
