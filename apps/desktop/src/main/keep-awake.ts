import { powerMonitor, powerSaveBlocker } from "electron"
import type { HostProcess } from "./host-process"

/** powerSaveBlocker 给的 id；没挡着时为 undefined。 */
let blocker: number | undefined
let manual = false
let suspended = false
let running = false
let host: HostProcess | undefined

/** 按开关挡住或放开系统睡眠；重复打开不会叠加。 */
export function setKeepAwake(on: boolean): void {
  manual = on
  updateBlocker()
}

function updateBlocker(): void {
  const on = manual || (running && !suspended && !powerMonitor.isOnBatteryPower())
  if (on && blocker === undefined) {
    blocker = powerSaveBlocker.start("prevent-app-suspension")
  } else if (!on && blocker !== undefined) {
    powerSaveBlocker.stop(blocker)
    blocker = undefined
  }
}

/** 在插电且 run 活跃时防止空闲睡眠；系统进入睡眠时尽量通知 Host 撤下手机连接。 */
export function monitorPower(): void {
  const setSuspended = (value: boolean) => {
    suspended = value
    host?.child.postMessage({ type: "power", suspended })
    updateBlocker()
  }
  powerMonitor.on("on-ac", updateBlocker)
  powerMonitor.on("on-battery", updateBlocker)
  powerMonitor.on("suspend", () => setSuspended(true))
  powerMonitor.on("resume", () => setSuspended(false))
  // Electron only emits AC/battery change events on macOS and Windows.
  if (process.platform === "linux") setInterval(updateBlocker, 5_000).unref()
}

export function watchHostActivity(current: HostProcess): void {
  host = current
  running = false
  updateBlocker()
  if (suspended) current.child.postMessage({ type: "power", suspended })
  current.controlPort.on("message", ({ data }) => {
    if (host !== current || data?.type !== "host.running" || typeof data.running !== "boolean") return
    running = data.running
    updateBlocker()
  })
  current.controlPort.start()
  current.child.once("exit", () => {
    if (host !== current) return
    host = undefined
    running = false
    updateBlocker()
  })
}
