/** 启动并监督 Host utilityProcess，分配控制与应用两条 MessageChannel。 */
import { MessageChannelMain, utilityProcess } from "electron"
import type { MessagePortMain, UtilityProcess } from "electron"

/** 由 main 持有的 Host 子进程与两条端口。 */
export interface HostProcess {
  child: UtilityProcess
  appPort: MessagePortMain
  controlPort: MessagePortMain
  stop(): void
}

/** 以 utilityProcess 方式启动 Host，并把端口转交给子进程。 */
export function startHostProcess(entry: string, profileDir: string): HostProcess {
  const control = new MessageChannelMain()
  const app = new MessageChannelMain()
  const child = utilityProcess.fork(entry, [], {
    stdio: "pipe",
    env: { ...process.env, PIGCODE_PROFILE_DIR: profileDir },
  })
  child.postMessage({ type: "ports" }, [control.port1, app.port1])
  return {
    child,
    controlPort: control.port2,
    appPort: app.port2,
    stop() {
      child.kill()
    },
  }
}
