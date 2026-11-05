/**
 * 有任务在跑时的退出确认（pigcode/pigcode#65）。窗口隐藏到托盘时先把它叫出来：
 * macOS 上挂在隐藏窗口上的 sheet 不会显示，主进程会一直等一个看不见的答案。
 */
import { app, dialog, type BrowserWindow } from "electron"
import { quitDetail, quitLabels } from "./locale/quit"
import type { QuitState } from "./quit-check"

/** 问一次；用户选「退出」返回 true。 */
export async function confirmQuit(
  getWindow: () => BrowserWindow | undefined,
  state: QuitState,
): Promise<boolean> {
  const window = getWindow()
  if (window && !window.isDestroyed() && !window.isVisible()) window.show()
  const labels = quitLabels(app.getLocale())
  const options = {
    type: "warning" as const,
    buttons: [labels.quit, labels.stay],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: labels.title,
    detail: quitDetail(labels, state).join("\n"),
  }
  const { response } =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options)
  return response === 0
}
