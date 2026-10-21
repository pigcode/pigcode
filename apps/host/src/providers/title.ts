/** 线程自动命名：默认标题的线程在第一条用户消息后取首句作为标题。 */
import type { Context } from "cordis"
import type { Thread, ThreadEvent } from "@pigcode/contracts"

/** 创建线程时使用过的默认标题；只有这些标题会被自动替换。 */
const DEFAULT_TITLES = new Set(["新会话", "New thread"])

/** 写回 `thread.updated`，让侧栏、tab 和 store 同步新标题。 */
export function maybeAutoTitle(
  ctx: Context,
  thread: Thread,
  text: string,
  runId: string,
  append: (
    threadId: string,
    runId: string | null,
    type: ThreadEvent["type"],
    payload: unknown,
  ) => void,
): void {
  if (!DEFAULT_TITLES.has(thread.title.trim())) return
  const hasUserMessage = ctx.sessions
    .read(thread.id, 0)
    .some(
      (event) =>
        event.type === "message.completed" &&
        typeof event.payload === "object" &&
        event.payload !== null &&
        (event.payload as { role?: unknown }).role === "user",
    )
  if (hasUserMessage) return
  const firstLine = text.replace(/\s+/g, " ").trim().split(/[。！？.!?]/)[0]?.trim() ?? ""
  if (!firstLine) return
  const updated = ctx.threads.rename(thread.id, firstLine.slice(0, 36))
  if (updated) append(thread.id, runId, "thread.updated", { title: updated.title })
}
