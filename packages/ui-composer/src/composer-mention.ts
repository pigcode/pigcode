/** 从输入框之外（文件树的「添加到对话」）在光标处插入一个 @文件 引用。 */
export const COMPOSER_MENTION_EVENT = "pigcode:composer-mention"

/** 请求当前输入框插入 @path；没有挂载输入框时什么也不做。 */
export function requestComposerMention(path: string): void {
  window.dispatchEvent(new CustomEvent(COMPOSER_MENTION_EVENT, { detail: { path } }))
}

/** 读出事件里的路径；不是合法事件时返回 null。 */
export function mentionPathOf(event: Event): string | null {
  const path = (event as CustomEvent<{ path?: unknown }>).detail?.path
  return typeof path === "string" && path.length > 0 ? path : null
}
