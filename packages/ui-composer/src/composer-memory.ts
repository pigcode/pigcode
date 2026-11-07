/**
 * 输入框的记忆：每个会话的未发送草稿，发送过的消息历史（↑/↓ 翻找），以及从外面预填、换了归属的草稿。
 * 只保存在本次运行的内存里，切换会话、切到设置页再回来时草稿还在。
 */
import type { JSONContent } from "@tiptap/react"
import {
  moveComposerContexts,
  prefillComposerContexts,
  resetComposerContexts,
  type ComposerContext,
} from "./composer-context"

const drafts = new Map<string, JSONContent>()
const history: string[] = []
const HISTORY_LIMIT = 50

/** 保存草稿；空文档等同于删除。 */
export function saveDraft(key: string, content: JSONContent | null): void {
  if (content) drafts.set(key, content)
  else drafts.delete(key)
}

/** 读取草稿。 */
export function loadDraft(key: string): JSONContent | null {
  return drafts.get(key) ?? null
}

/** 记一条发送过的消息；和上一条相同时不重复记录。 */
export function rememberSent(text: string): void {
  if (!text || history.at(-1) === text) return
  history.push(text)
  if (history.length > HISTORY_LIMIT) history.shift()
}

/** 第 n 条历史（0 是最近一条）；越界时返回 null。 */
export function sentAt(offset: number): string | null {
  return history[history.length - 1 - offset] ?? null
}

/** 历史条数。 */
export function sentCount(): number {
  return history.length
}

/** 打开会话时要把光标放到末尾的会话（刚预填过草稿）。 */
const focusRequests = new Set<string>()

/** 预填的那个输入框已经挂着时，用这个事件让它立刻换上预填的内容。 */
export const COMPOSER_PREFILL_EVENT = "pigcode:composer-prefill"

/**
 * 预填某个会话的输入框：文字写进草稿，附件放到输入框上方，光标停在文字末尾。输入框还没挂载时，
 * 打开这个会话时换上；已经挂着时立刻换上。不发送；用户补完再发。「创建插件」与新会话的建议用它。
 */
export function prefillComposer(
  key: string,
  draft: { text: string; contexts?: readonly ComposerContext[] | undefined },
): void {
  saveDraft(key, {
    type: "doc",
    content: [
      { type: "paragraph", content: draft.text ? [{ type: "text", text: draft.text }] : [] },
    ],
  })
  if (draft.contexts) prefillComposerContexts(key, draft.contexts)
  focusRequests.add(key)
  window.dispatchEvent(new CustomEvent(COMPOSER_PREFILL_EVENT, { detail: { key } }))
}

/** 还挂着的输入框收到它时把内容存进草稿、清空自己，草稿好搬去别的键。 */
export const COMPOSER_TAKE_EVENT = "pigcode:composer-take"

/**
 * 草稿换了归属（新会话草稿建成了会话）：还挂着的旧输入框先交出正在写的内容，文字与附件搬到新键下，
 * 光标停在文字末尾；新键的输入框已经挂着时立刻换上，还没挂载时打开时换上。
 */
export function moveComposerDraft(from: string, to: string): void {
  if (from === to) return
  window.dispatchEvent(new CustomEvent(COMPOSER_TAKE_EVENT, { detail: { key: from } }))
  const draft = drafts.get(from)
  drafts.delete(from)
  const contexts = moveComposerContexts(from, to)
  if (draft) drafts.set(to, draft)
  else if (!contexts) return
  focusRequests.add(to)
  if (draft) window.dispatchEvent(new CustomEvent(COMPOSER_PREFILL_EVENT, { detail: { key: to } }))
}

/** 读出预填与交出事件里的输入框键；不是合法事件时返回 null。 */
export function prefillKeyOf(event: Event): string | null {
  const key = (event as CustomEvent<{ key?: unknown }>).detail?.key
  return typeof key === "string" ? key : null
}

/** 这个会话刚预填过：取一次后清掉。 */
export function takeComposerFocus(key: string): boolean {
  return focusRequests.delete(key)
}

/** 测试用：清空草稿、历史与附件。 */
export function resetComposerMemory(): void {
  drafts.clear()
  history.length = 0
  focusRequests.clear()
  resetComposerContexts()
}
