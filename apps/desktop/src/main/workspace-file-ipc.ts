/** 文件导航的系统操作，源文件必须位于当前工作目录内。 */
import { copyFile, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import { appDefsFor, detectApps } from "./open-apps"
import { launchCommand, launchDetached, settleOpenPath } from "./open-in"

function inside(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}

async function workspaceFile(root: unknown, path: unknown): Promise<string> {
  if (
    typeof root !== "string" ||
    !isAbsolute(root) ||
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    path.split(/[\\/]/).includes(".git")
  )
    throw new Error("FILE_NOT_FOUND")
  const candidate = resolve(root, path)
  if (!inside(resolve(root), candidate)) throw new Error("FILE_NOT_FOUND")
  const [base, file] = await Promise.all([realpath(root), realpath(candidate)])
  if (
    !inside(base, file) ||
    relative(base, file).split(sep).includes(".git") ||
    !(await stat(file)).isFile()
  )
    throw new Error("FILE_NOT_FOUND")
  return file
}

/** 注册「用应用打开文件」和「另存为」，后者只在系统对话框确认后复制。 */
export function registerWorkspaceFileIpc(): void {
  ipcMain.handle(
    "pigcode:open-workspace-file",
    async (_event, root: unknown, path: unknown, appId: unknown) => {
      const file = await workspaceFile(root, path)
      if (appId === null) {
        const error = await settleOpenPath(shell.openPath(file))
        if (error) throw new Error(error)
        return
      }
      const editor = detectApps(appDefsFor()).find(
        (item) => item.def.kind === "editor" && item.def.id === appId,
      )
      const launch = editor && launchCommand(editor, file)
      if (!launch) throw new Error("APP_NOT_FOUND")
      await launchDetached(launch.command, launch.args, dirname(file))
    },
  )
  ipcMain.handle("pigcode:save-workspace-file", async (event, root: unknown, path: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false
    const file = await workspaceFile(root, path)
    const destination = await dialog.showSaveDialog(window, {
      defaultPath: join(app.getPath("downloads"), basename(file)),
    })
    if (destination.canceled || !destination.filePath) return false
    await copyFile(await workspaceFile(root, path), destination.filePath)
    return true
  })
}
