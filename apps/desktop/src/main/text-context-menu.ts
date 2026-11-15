/** 未被页面接管的文字右键，用操作系统菜单执行编辑命令。 */
import {
  app,
  Menu,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from "electron"
import { textContextMenuLabels } from "./locale/text-context-menu"

type TextContext = Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">

/** 输入区显示编辑项，只有选中文字的只读内容才显示复制。 */
function textContextMenuItems(context: TextContext, locale: string): MenuItemConstructorOptions[] {
  const labels = textContextMenuLabels(locale)
  const flags = context.editFlags
  const item = (role: keyof typeof labels, enabled: boolean): MenuItemConstructorOptions => ({
    role,
    label: labels[role],
    enabled,
  })
  if (!context.isEditable) {
    return context.selectionText && flags.canCopy ? [item("copy", true)] : []
  }
  return [
    item("undo", flags.canUndo),
    item("redo", flags.canRedo),
    { type: "separator" },
    item("cut", flags.canCut),
    item("copy", flags.canCopy),
    item("paste", flags.canPaste),
    { type: "separator" },
    item("selectAll", flags.canSelectAll),
  ]
}

export function installTextContextMenu(window: BrowserWindow): void {
  window.webContents.on("context-menu", (_event, context) => {
    const items = textContextMenuItems(context, app.getLocale())
    if (items.length === 0) return
    Menu.buildFromTemplate(items).popup({ window, x: context.x, y: context.y })
  })
}
