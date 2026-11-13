/**
 * 输入框上方的上下文附件，例如内置浏览器里选中的网页元素、「创建插件」附上的指南。附件和草稿一样按会话记在内存里，
 * 切走再回来还在；发送时以 Markdown 段落接在文字后面一起发出，发送后清空。刷新窗口后不保留。
 */
import { useEffect, useRef, useSyncExternalStore } from "react"
import { SquareMousePointer, X } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"

export const COMPOSER_CONTEXT_EVENT = "pigcode:composer-context"

/** 一个上下文附件。 */
export interface ComposerContext {
  /** 同一个 id 再加一次时替换原来的。 */
  id: string
  /** 附件上显示的简称。 */
  label: string
  /** 悬停时显示的完整说明。 */
  title?: string | undefined
  /** 发送时接在文字后面的 Markdown。 */
  markdown: string
}

/** 请求当前输入框加一个附件；没有挂载输入框时什么也不做。 */
export function requestComposerContext(context: ComposerContext): void {
  window.dispatchEvent(new CustomEvent(COMPOSER_CONTEXT_EVENT, { detail: context }))
}

function contextOf(event: Event): ComposerContext | null {
  const detail = (event as CustomEvent<Partial<ComposerContext> | undefined>).detail
  if (!detail || typeof detail.id !== "string" || typeof detail.label !== "string") return null
  if (typeof detail.markdown !== "string" || detail.markdown.trim() === "") return null
  return {
    id: detail.id,
    label: detail.label,
    markdown: detail.markdown,
    title: typeof detail.title === "string" ? detail.title : undefined,
  }
}

/** 把附件接在文字后面；没有文字时只发附件。 */
export function withContexts(text: string, contexts: readonly ComposerContext[]): string {
  return [text, ...contexts.map((context) => context.markdown)]
    .filter((part) => part.trim() !== "")
    .join("\n\n")
}

const EMPTY: readonly ComposerContext[] = []
/** 没有会话的输入框（首页）用的键。 */
const NO_THREAD = "\u0000no-thread"
const store = new Map<string, readonly ComposerContext[]>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function contextsFor(key: string): readonly ComposerContext[] {
  return store.get(key) ?? EMPTY
}

function setContexts(key: string, contexts: readonly ComposerContext[]): void {
  if (contexts.length > 0) store.set(key, contexts)
  else store.delete(key)
  for (const listener of listeners) listener()
}

/** 给某个会话的输入框预先放好附件（同 id 替换）；输入框挂载后就能看到。 */
export function prefillComposerContexts(key: string, contexts: readonly ComposerContext[]): void {
  const ids = new Set(contexts.map((context) => context.id))
  setContexts(key, [...contextsFor(key).filter((item) => !ids.has(item.id)), ...contexts])
}

/** 附件换了归属（新会话草稿建成了会话）：搬到新键下；返回有没有搬动。 */
export function moveComposerContexts(from: string, to: string): boolean {
  const moving = contextsFor(from)
  if (moving.length === 0 || from === to) return false
  store.delete(from)
  prefillComposerContexts(to, moving)
  return true
}

/** 测试用：清空全部附件。 */
export function resetComposerContexts(): void {
  store.clear()
  for (const listener of listeners) listener()
}

/**
 * 当前会话的附件，并订阅附件事件；禁用时不接收。onAdd 在加上附件后调用，例如让输入框获得焦点。
 * draftKey 是会话 id，和草稿用同一个键。
 */
export function useComposerContexts(disabled: boolean, onAdd: () => void, draftKey: string | null) {
  const key = draftKey ?? NO_THREAD
  const contexts = useSyncExternalStore(subscribe, () => contextsFor(key))
  const added = useRef(onAdd)
  added.current = onAdd
  useEffect(() => {
    if (disabled) return undefined
    const onContext = (event: Event): void => {
      const context = contextOf(event)
      if (!context) return
      prefillComposerContexts(key, [context])
      added.current()
    }
    window.addEventListener(COMPOSER_CONTEXT_EVENT, onContext)
    return () => window.removeEventListener(COMPOSER_CONTEXT_EVENT, onContext)
  }, [disabled, key])
  return {
    contexts,
    remove: (id: string) =>
      setContexts(
        key,
        contextsFor(key).filter((item) => item.id !== id),
      ),
    clear: () => setContexts(key, EMPTY),
  }
}

/** 输入框上方的一排附件，每个都能单独移除。 */
export function ComposerContextChips({
  contexts,
  onRemove,
}: {
  contexts: readonly ComposerContext[]
  onRemove: (id: string) => void
}) {
  const { t } = useLocale()
  if (contexts.length === 0) return null
  return (
    <div className="composer-contexts">
      {contexts.map((context) => (
        <span key={context.id} className="composer-context" title={context.title ?? context.label}>
          <SquareMousePointer className="ic ic-sm" aria-hidden="true" />
          <span className="truncate">{context.label}</span>
          <button
            type="button"
            className="composer-context-remove"
            aria-label={t("composer.context.remove").replace("{label}", context.label)}
            onClick={() => onRemove(context.id)}
          >
            <X className="ic ic-xs" aria-hidden="true" />
          </button>
        </span>
      ))}
    </div>
  )
}
