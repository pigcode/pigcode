/**
 * 从输入框之外在光标处插入一个 @ 引用：文件树的「添加到对话」插入 @文件，
 * 侧栏会话菜单的「在输入框里引用」插入 @会话（#81）。
 */
import { THREAD_MENTION_PREFIX } from "./composer-threads"

export const COMPOSER_MENTION_EVENT = "pigcode:composer-mention"

/** 请求当前输入框插入 @path；没有挂载输入框时什么也不做。 */
export function requestComposerMention(path: string): void {
  window.dispatchEvent(new CustomEvent(COMPOSER_MENTION_EVENT, { detail: { path } }))
}

/** 请求当前输入框插入一个会话引用；没有挂载输入框时什么也不做。 */
export function requestComposerThreadMention(threadId: string, title: string): void {
  window.dispatchEvent(
    new CustomEvent(COMPOSER_MENTION_EVENT, { detail: { thread: { id: threadId, title } } }),
  )
}

/** 读出事件里要插入的标记（Mention 节点的 id 与显示文字）；不是合法事件时返回 null。 */
export function mentionOf(event: Event): { id: string; label: string } | null {
  const detail = (
    event as CustomEvent<{ path?: unknown; thread?: { id?: unknown; title?: unknown } }>
  ).detail
  if (typeof detail?.path === "string" && detail.path.length > 0) {
    return { id: detail.path, label: detail.path }
  }
  const thread = detail?.thread
  if (typeof thread?.id === "string" && thread.id && typeof thread.title === "string") {
    return { id: `${THREAD_MENTION_PREFIX}${thread.id}`, label: thread.title }
  }
  return null
}
