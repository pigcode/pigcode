/** 线程运行状态：侧栏状态点的取值与可读文案。 */
import type { MessageKey } from "@pigcode/ui-primitives"

/** 状态点取值；与 Renderer 的线程视图状态保持一致。 */
export type ThreadStatus =
  "idle" | "queued" | "running" | "waiting-approval" | "completed" | "failed" | "interrupted"

/** 线程状态到 locale key 的映射；idle 不显示可读状态文案。 */
export const THREAD_STATUS_MESSAGE: Record<ThreadStatus, MessageKey | null> = {
  idle: null,
  queued: "tabs.status.queued",
  running: "tabs.status.running",
  "waiting-approval": "tabs.status.waitingApproval",
  completed: "tabs.status.completed",
  failed: "tabs.status.failed",
  interrupted: "tabs.status.interrupted",
}
