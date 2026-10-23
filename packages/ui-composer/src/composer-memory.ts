/**
 * 输入框的记忆：每个会话的未发送草稿，以及发送过的消息历史（↑/↓ 翻找）。
 * 只保存在本次运行的内存里，切换会话、切到设置页再回来时草稿还在。
 */
import type { JSONContent } from "@tiptap/react"

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

/** 测试用：清空草稿与历史。 */
export function resetComposerMemory(): void {
  drafts.clear()
  history.length = 0
}
