import type { Context } from "cordis"
import type { HostMessagePort } from "./message-port-transport"

/** Electron keeps the machine awake on AC while an active run can still continue. */
export function attachHostActivity(port: Pick<HostMessagePort, "postMessage">, ctx: Context): void {
  let running: boolean | undefined
  const publish = () => {
    const next = ctx.agents.listRuns().some(({ status }) =>
      status === "running" || status === "waiting-approval" || status === "waiting-input",
    )
    if (running === next) return
    running = next
    port.postMessage({ type: "host.running", running })
  }
  ctx.effect(() => {
    let pending = false
    let disposed = false
    const unsubscribe = ctx.sessions.subscribeAll(({ type }) => {
      if (!type.startsWith("run.") || pending) return
      pending = true
      // run.started can be appended before the run enters the active map.
      queueMicrotask(() => {
        pending = false
        if (!disposed) publish()
      })
    })
    return () => {
      disposed = true
      unsubscribe()
    }
  })
  publish()
}
