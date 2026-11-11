/** 等一轮 turn 结束：收到匹配的 turn/completed、run 被取消，或者 app-server 中途退出。 */
import type { CodexRpcClient } from "./client"

/** 等待匹配 turnId 的 turn/completed，或等待 run 的取消信号。 */
export function waitForTurn(
  client: CodexRpcClient,
  turnId: string | null,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let dispose: () => void = () => undefined
    const finish = (): void => {
      if (settled) return
      settled = true
      dispose()
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const disposeCompleted = client.onNotification("turn/completed", (params) => {
      const completed = completedTurnId(params)
      if (turnId && completed && completed !== turnId) return
      finish()
    })
    // app-server 中途退出时这一轮不会再有 turn/completed；以失败结束，而不是一直等。
    const disposeClose = client.onClose((reason) => {
      if (settled) return
      settled = true
      dispose()
      signal.removeEventListener("abort", finish)
      reject(reason)
    })
    dispose = () => {
      disposeCompleted()
      disposeClose()
    }
    signal.addEventListener("abort", finish, { once: true })
    if (signal.aborted) finish()
  })
}

/** 从 turn/completed 的 params 中读取 turn id。 */
function completedTurnId(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null) return undefined
  const record = params as Record<string, unknown>
  const turn = record.turn
  if (typeof turn === "object" && turn !== null) {
    const id = (turn as Record<string, unknown>).id
    if (typeof id === "string") return id
  }
  return typeof record.turnId === "string" ? record.turnId : undefined
}
