/** 线程自动命名：默认标题的线程在第一条用户消息后取首句作为标题；纯图片消息按文件名或「图片消息」兜底。 */
import type { Context } from "cordis"
import type { ImageAttachmentRef, Thread, ThreadEvent } from "@pigcode/contracts"

/** 创建线程时使用过的默认标题；只有这些标题会被自动替换。 */
const DEFAULT_TITLES = new Set(["新会话", "New thread"])

/** 常见的剪贴板/默认泛名；纯图片消息遇到这类名字时统一显示「图片消息」。 */
const GENERIC_IMAGE_STEM =
  /^(?:image|img|photo|picture|clipboard|pasted[-_\s]?image|screenshot|untitled)(?:[-_\s]?\d*)?$/i

function fallbackAttachmentTitle(attachments?: readonly ImageAttachmentRef[]): string {
  const first = attachments?.[0]?.fileName?.trim()
  if (!first) return ""
  const stem = first.replace(/\.[^.]+$/, "")
  if (!stem || GENERIC_IMAGE_STEM.test(stem)) return "图片消息"
  return first.slice(0, 36)
}

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
  attachments?: readonly ImageAttachmentRef[],
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
  const firstLine =
    text
      .replace(/\s+/g, " ")
      .trim()
      .split(/[。！？.!?]/)[0]
      ?.trim() ?? ""
  const title = firstLine ? firstLine.slice(0, 36) : fallbackAttachmentTitle(attachments)
  if (!title) return
  const updated = ctx.threads.rename(thread.id, title)
  if (updated) append(thread.id, runId, "thread.updated", { title: updated.title })
}
