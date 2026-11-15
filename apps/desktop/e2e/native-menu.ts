/** 让用例选中系统菜单项，保留实际的右键入口和渲染进程的动作分发。 */
import type { ElectronApplication } from "@playwright/test"

export async function chooseNativeMenuItem(app: ElectronApplication, id: string): Promise<void> {
  await app.evaluate(({ ipcMain }, choice) => {
    ipcMain.removeHandler("pigcode:menu")
    ipcMain.handle("pigcode:menu", (_event, items: Array<{ id?: string }>) => {
      if (!items.some((item) => item.id === choice))
        throw new Error(`Menu item not found: ${choice}`)
      return choice
    })
  }, id)
}
