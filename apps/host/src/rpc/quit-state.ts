/**
 * 退出前查询还有没有在跑的工作：main 在关掉应用之前问一次，有任务时弹确认框（pigcode/monorepo#65）。
 * 走控制端口，不经过渲染进程——窗口可能已经关掉或连不上。
 */
import type { Context } from "cordis"

/** 退出时会让用户犹豫的几类工作。 */
export interface QuitState {
  /** 运行中和排队中的 run。 */
  runs: number
  /** 等待用户处理的审批与提问。 */
  approvals: number
  /** 已启用的定时任务；退出后不会触发。 */
  schedules: number
}

/** 控制端口上的请求与应答形状。 */
export interface QuitStateRequest {
  type: "app.quit-state"
  id: number
}

export interface QuitStateReply extends QuitState {
  type: "app.quit-state"
  id: number
  state: QuitState
}

/** 最小端口接口：Host 拿到的控制端口是 Electron 的 MessagePortMain，监听器收到的是 MessageEvent。 */
export interface QuitStatePort {
  on(event: "message", listener: (value: unknown) => void): void
  postMessage(message: unknown): void
  /** MessagePortMain 收到 start() 之前不派发消息；测试的假端口没有这个方法。 */
  start?(): void
}

/** 取出消息本身；直接传消息对象的端口（测试里）原样返回。 */
function messageData(value: unknown): unknown {
  return typeof value === "object" && value !== null && "data" in value
    ? (value as { data: unknown }).data
    : value
}

function countPendingRequests(ctx: Context): number {
  try {
    // 只数还挂着的：历史记录会一直留在这张表里（status 变成 resolved 或 orphaned）。
    const row = ctx.storage.db
      .prepare("SELECT COUNT(*) AS n FROM pending_requests WHERE status = 'pending'")
      .get() as { n?: unknown } | undefined
    return typeof row?.n === "number" ? row.n : 0
  } catch {
    // 表还没迁移出来时按 0 算：退出检查不能挡住退出。
    return 0
  }
}

/** 统计当前还有多少工作在跑。取不到的项按 0 算，宁可少拦一次也不要卡住退出。 */
export function readQuitState(ctx: Context): QuitState {
  const runs = ctx.agents
    .listRuns()
    .filter((run) => run.status === "running" || run.status === "queued")
  const schedules =
    ctx
      .get("schedules")
      ?.list()
      .filter((schedule) => schedule.status === "active") ?? []
  return {
    runs: runs.length,
    approvals: countPendingRequests(ctx),
    schedules: schedules.length,
  }
}

/** 在控制端口上应答退出检查；其他消息留给内置浏览器。 */
export function attachQuitState(port: QuitStatePort, ctx: Context): void {
  // 不能指望其他监听者先 start()：浏览器插件加载失败时也要能回答。
  port.start?.()
  port.on("message", (value) => {
    const data = messageData(value) as Partial<QuitStateRequest> | undefined
    if (data?.type !== "app.quit-state" || typeof data.id !== "number") return
    port.postMessage({ type: "app.quit-state", id: data.id, state: readQuitState(ctx) })
  })
}
