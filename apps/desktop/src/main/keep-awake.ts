/** 「保持电脑唤醒」：打开时用 powerSaveBlocker 挡住系统睡眠，定时任务才能按时运行；关掉时放开。 */
import { powerSaveBlocker } from "electron"

/** powerSaveBlocker 给的 id；没挡着时为 undefined。 */
let blocker: number | undefined

/** 按开关挡住或放开系统睡眠；重复打开不会叠加。 */
export function setKeepAwake(on: boolean): void {
  if (on && blocker === undefined) {
    blocker = powerSaveBlocker.start("prevent-app-suspension")
  } else if (!on && blocker !== undefined) {
    powerSaveBlocker.stop(blocker)
    blocker = undefined
  }
}
