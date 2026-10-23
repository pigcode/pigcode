/**
 * 输入框的 TipTap 扩展：纯文本正文（不做加粗/斜体等格式，发出去的就是用户敲的字），
 * @ 引用项目文件（插入文件标记，发送时写成 @路径），/ 在行首调出命令。
 */
import Mention from "@tiptap/extension-mention"
import { Placeholder } from "@tiptap/extension-placeholder"
import { PluginKey } from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"
import type { Editor, Extensions, JSONContent } from "@tiptap/react"
import StarterKit from "@tiptap/starter-kit"
import {
  exitSuggestion,
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion"
import { matchByLabel, matchFiles } from "./fuzzy"
import { createSmartPunctuation } from "./smart-punctuation"
import type { SuggestionItem, SuggestionStore } from "./suggestion-store"

/** 斜杠命令；run 在用户选中后执行，命令文字会从输入框里删掉。 */
export interface ComposerCommand {
  id: string
  label: string
  description?: string | undefined
  keywords?: readonly string[] | undefined
  run: () => void
}

/** 扩展读取的最新配置；用 getter 读取，编辑器不必随 props 重建。 */
export interface ComposerEditorSources {
  placeholder: () => string
  smartPunctuation: () => boolean
  files: () => (() => Promise<readonly string[]>) | undefined
  commands: () => readonly ComposerCommand[]
}

export const FILE_SUGGESTION_KEY = new PluginKey("composer-file-suggestion")
export const COMMAND_SUGGESTION_KEY = new PluginKey("composer-command-suggestion")

/** 把 suggestion 插件的生命周期接到 store。 */
function renderInto(store: SuggestionStore, kind: SuggestionItem["kind"], key: PluginKey) {
  return () => ({
    onStart: (props: SuggestionProps<SuggestionItem, SuggestionItem>) => store.show(kind, props),
    onUpdate: (props: SuggestionProps<SuggestionItem, SuggestionItem>) => store.show(kind, props),
    onExit: () => store.hide(),
    onKeyDown: ({ event, view }: SuggestionKeyDownProps) => {
      if (event.key === "Escape") {
        exitSuggestion(view, key)
        store.hide()
        return true
      }
      return store.handleKey(event)
    },
  })
}

/** 构造输入框的扩展列表。文件列表在一次建议期间只读取一次。 */
export function composerExtensions(
  sources: ComposerEditorSources,
  store: SuggestionStore,
): Extensions {
  let filesRequest: Promise<readonly string[]> | null = null
  const loadFiles = (): Promise<readonly string[]> => {
    const source = sources.files()
    if (!source) return Promise.resolve([])
    filesRequest ??= source().catch(() => [])
    return filesRequest
  }
  return [
    StarterKit.configure({
      bold: false,
      italic: false,
      strike: false,
      code: false,
      underline: false,
      link: false,
      heading: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      blockquote: false,
      codeBlock: false,
      horizontalRule: false,
    }),
    Placeholder.configure({ placeholder: () => sources.placeholder() }),
    createSmartPunctuation(() => sources.smartPunctuation()),
    Mention.configure({
      HTMLAttributes: { class: "mention-chip" },
      renderText: ({ node }) => `@${String(node.attrs.id ?? "")}`,
      renderHTML: ({ node, options }) => [
        "span",
        { ...options.HTMLAttributes, "data-type": "mention", "data-id": node.attrs.id },
        `@${String(node.attrs.label ?? node.attrs.id ?? "")}`,
      ],
      suggestions: [
        {
          char: "@",
          pluginKey: FILE_SUGGESTION_KEY,
          items: async ({ query }) =>
            matchFiles(await loadFiles(), query).map((path): SuggestionItem => ({
              id: path,
              label: path,
              kind: "file",
            })),
          command: ({ editor, range, props }) => {
            editor
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: "mention", attrs: { id: props.id, label: props.label } },
                { type: "text", text: " " },
              ])
              .run()
          },
          render: () => {
            const handlers = renderInto(store, "file", FILE_SUGGESTION_KEY)()
            return {
              ...handlers,
              onExit: () => {
                filesRequest = null
                handlers.onExit()
              },
            }
          },
        },
        {
          char: "/",
          pluginKey: COMMAND_SUGGESTION_KEY,
          startOfLine: true,
          items: ({ query }) =>
            matchByLabel(sources.commands(), query).map((command): SuggestionItem => ({
              id: command.id,
              label: command.label,
              detail: command.description,
              kind: "command",
            })),
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).run()
            sources
              .commands()
              .find((command) => command.id === props.id)
              ?.run()
          },
          render: renderInto(store, "command", COMMAND_SUGGESTION_KEY),
        },
      ],
    }),
  ]
}

/** 发送的纯文本：段落之间一个换行，文件标记写成 @路径。 */
export function editorText(editor: Editor): string {
  return editor.getText({ blockSeparator: "\n" }).trim()
}

/** 粘贴时只取纯文本，换行变成软换行；剪贴板里没有文本（例如图片）时交给默认处理。 */
export function pastePlainText(editor: Editor, _view: EditorView, event: ClipboardEvent): boolean {
  const text = event.clipboardData?.getData("text/plain")
  if (!text) return false
  const content: JSONContent[] = []
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line, index) => {
      if (index > 0) content.push({ type: "hardBreak" })
      if (line) content.push({ type: "text", text: line })
    })
  editor.chain().focus().insertContent(content).run()
  return true
}

/** 当前是否停在空文档（只有一个空段落）。 */
export function isBlank(editor: Editor | null): boolean {
  return !editor || editor.isEmpty
}
