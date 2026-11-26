/** 输入框的键盘快捷处理、历史消息翻找、触发符插入，以及草稿/预填/外部引用同步效果。 */
import { useEffect } from "react"
import type { Editor } from "@tiptap/react"
import { COMPOSER_MENTION_EVENT, mentionOf } from "./composer-mention"
import {
  COMPOSER_PREFILL_EVENT,
  COMPOSER_TAKE_EVENT,
  loadDraft,
  prefillKeyOf,
  saveDraft,
  sentAt,
  takeComposerFocus,
} from "./composer-memory"
import { setPlainText } from "./composer-editor"
import { getComposerKeyAction, nextPermissionMode, type PermissionMode } from "./composer-options"
import type { SuggestionStore } from "./suggestion-store"

export interface ComposerHistoryState {
  offset: number
  text: string
}

interface MutableRef<T> {
  current: T
}

/** ↑/↓ 在空输入框里翻找发送过的消息；返回是否处理了按键。 */
export function browseSentHistory(
  editor: Editor,
  direction: 1 | -1,
  historyRef: MutableRef<ComposerHistoryState | null>,
): boolean {
  const navigating = historyRef.current
  if (!navigating && (direction < 0 || !editor.isEmpty)) return false
  const offset = navigating ? navigating.offset + direction : 0
  if (offset < 0) {
    historyRef.current = null
    editor.commands.clearContent(true)
    return true
  }
  const text = sentAt(offset)
  if (text === null) return Boolean(navigating)
  historyRef.current = { offset, text }
  setPlainText(editor, text)
  return true
}

/** 在光标处插入触发字符，打开对应的建议列表。 */
export function insertComposerTrigger(editor: Editor | null, char: "@" | "/"): void {
  if (!editor) return
  const before = editor.state.selection.$from.parent.textContent.slice(
    0,
    editor.state.selection.$from.parentOffset,
  )
  const prefix = char === "@" && before && !/\s$/.test(before) ? " " : ""
  editor.chain().focus().insertContent(`${prefix}${char}`).run()
}

export interface ComposerKeyDownContext {
  editor: Editor | null
  event: KeyboardEvent
  store: SuggestionStore
  historyRef: MutableRef<ComposerHistoryState | null>
  isForm: boolean
  permissionMode: PermissionMode
  availableModes: Parameters<typeof nextPermissionMode>[1]
  onPermissionMode?: ((mode: PermissionMode) => void) | undefined
  onTogglePicker: () => void
  onSend: () => void
}

/** TipTap handleKeyDown 逻辑：建议列表避让、快捷键切换模型/权限、历史翻找与回车发送。 */
export function handleComposerKeyDown({
  editor,
  event,
  store,
  historyRef,
  isForm,
  permissionMode,
  availableModes,
  onPermissionMode,
  onTogglePicker,
  onSend,
}: ComposerKeyDownContext): boolean {
  if (!editor || event.isComposing) return false
  const suggesting = store.getSnapshot()
  // 建议列表打开时，方向键、回车、Tab、Esc 交给建议列表。
  if (suggesting.active && ["ArrowUp", "ArrowDown", "Tab", "Escape"].includes(event.key)) {
    return false
  }
  if (suggesting.active && event.key === "Enter" && suggesting.items.length > 0) return false
  if ((event.metaKey || event.ctrlKey) && event.key === "/") {
    event.preventDefault()
    onTogglePicker()
    return true
  }
  if (event.key === "Tab" && event.shiftKey && onPermissionMode) {
    event.preventDefault()
    onPermissionMode(nextPermissionMode(permissionMode, availableModes))
    return true
  }
  const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
  if (plain && event.key === "ArrowUp" && browseSentHistory(editor, 1, historyRef)) return true
  if (plain && event.key === "ArrowDown" && browseSentHistory(editor, -1, historyRef)) return true
  if (isForm && event.key === "Enter" && !(event.metaKey || event.ctrlKey)) return false
  const action = getComposerKeyAction(event.key, event.shiftKey)
  if (action === "ignore" || action === "newline") return false
  event.preventDefault()
  onSend()
  return true
}

/** 同步编辑器的可编辑状态、自动聚焦、草稿记忆、外部预填与 @ 引用事件。 */
export function useComposerEditorSync({
  editor,
  editorRef,
  draftKey,
  draftKeyRef,
  historyRef,
  disabled,
  autoFocus,
  focusKey,
  focusedKeyRef,
  acceptsExternalContext,
}: {
  editor: Editor | null
  editorRef: MutableRef<Editor | null>
  draftKey: string | null
  draftKeyRef: MutableRef<string | null>
  historyRef: MutableRef<ComposerHistoryState | null>
  disabled: boolean
  autoFocus: boolean
  focusKey: number | undefined
  focusedKeyRef: MutableRef<number | undefined>
  acceptsExternalContext: boolean
}): void {
  useEffect(() => {
    editor?.setEditable(!disabled, false)
  }, [editor, disabled])

  useEffect(() => {
    // TipTap 的 commands.focus() 会把 view.focus() 推迟到下一帧 rAF，若用户在首帧内点了
    // 顶部按钮或菜单，延迟聚焦会抢回焦点并触发 focus-out 关掉刚打开的浮层；这里同步聚焦。
    if (autoFocus && !disabled && editor && !editor.isDestroyed) {
      editor.view.focus()
    }
  }, [autoFocus, disabled, editor])

  useEffect(() => {
    if (focusKey === focusedKeyRef.current) return
    focusedKeyRef.current = focusKey
    if (!disabled) editor?.commands.focus("end")
  }, [focusKey, disabled, editor, focusedKeyRef])

  // 预填的正是这个输入框（新会话的建议、「创建插件」）：立刻换上预填的内容。
  // 要把草稿搬走（新会话草稿建成了会话）：先存下正在写的内容，再清空自己。
  useEffect(() => {
    if (!editor) return undefined
    const onMemory = (event: Event): void => {
      const key = prefillKeyOf(event)
      if (!key || key !== draftKeyRef.current || editor.isDestroyed) return
      if (event.type === COMPOSER_TAKE_EVENT) {
        saveDraft(key, editor.isEmpty ? null : editor.getJSON())
        editor.commands.clearContent(false)
        return
      }
      historyRef.current = null
      editor.commands.setContent(loadDraft(key) ?? "", { emitUpdate: false })
      takeComposerFocus(key)
      editor.commands.focus("end")
    }
    const types = [COMPOSER_PREFILL_EVENT, COMPOSER_TAKE_EVENT]
    for (const type of types) window.addEventListener(type, onMemory)
    return () => types.forEach((type) => window.removeEventListener(type, onMemory))
  }, [editor, draftKeyRef, historyRef])

  // 切换会话时保存旧草稿、恢复新草稿；卸载时也保存一次。
  useEffect(() => {
    if (!editor) return
    const previous = draftKeyRef.current
    if (previous === draftKey) {
      const initial = draftKey ? loadDraft(draftKey) : null
      if (initial && editor.isEmpty) editor.commands.setContent(initial, { emitUpdate: false })
      if (draftKey && takeComposerFocus(draftKey)) editor.commands.focus("end")
      return
    }
    if (previous) saveDraft(previous, editor.isEmpty ? null : editor.getJSON())
    draftKeyRef.current = draftKey
    historyRef.current = null
    const next = draftKey ? loadDraft(draftKey) : null
    editor.commands.setContent(next ?? "", { emitUpdate: false })
    // 从外面预填的会话（「创建插件」）：光标停在预填文字的末尾，接着写。
    if (draftKey && takeComposerFocus(draftKey)) editor.commands.focus("end")
  }, [draftKey, editor, draftKeyRef, historyRef])

  useEffect(
    () => () => {
      const key = draftKeyRef.current
      const current = editorRef.current
      if (key && current && !current.isDestroyed) {
        saveDraft(key, current.isEmpty ? null : current.getJSON())
      }
    },
    [draftKeyRef, editorRef],
  )

  // 文件树的「添加到对话」、侧栏的「在输入框里引用」：在光标处插入引用，与输入 @ 选中的效果相同。
  useEffect(() => {
    if (!editor || !acceptsExternalContext) return undefined
    const onMention = (event: Event): void => {
      const mention = mentionOf(event)
      if (!mention || disabled) return
      editor
        .chain()
        .focus()
        .insertContent([
          { type: "mention", attrs: mention },
          { type: "text", text: " " },
        ])
        .run()
    }
    window.addEventListener(COMPOSER_MENTION_EVENT, onMention)
    return () => window.removeEventListener(COMPOSER_MENTION_EVENT, onMention)
  }, [editor, disabled, acceptsExternalContext])
}
