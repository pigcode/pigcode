/** Composer 用作表单字段时保留的草稿，交给调用方保存。 */
import type { Editor, JSONContent } from "@tiptap/react"
import { editorText, plainTextContent } from "./composer-editor"

export interface ComposerDraft {
  text: string
  document?: string | undefined
}

export interface ComposerForm {
  /** 挂载时恢复正文和引用；编辑后由 onChange 通知调用方。 */
  draft: ComposerDraft
  onChange: (draft: ComposerDraft) => void
  inputLabel: string
  submitLabel: string
  submitDisabled?: boolean
}

export function formContent({ text, document }: ComposerDraft): JSONContent {
  if (document) {
    try {
      const content = JSON.parse(document) as JSONContent | null
      if (content?.type === "doc" && Array.isArray(content.content)) return content
    } catch {
      // 没有可用的文档时仍然可以编辑已保存的纯文本。
    }
  }
  return plainTextContent(text)
}

export function readComposerDraft(editor: Editor): ComposerDraft {
  return { text: editorText(editor), document: JSON.stringify(editor.getJSON()) }
}
