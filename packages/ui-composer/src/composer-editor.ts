/**
 * 输入框的 TipTap 扩展：纯文本正文（不做加粗/斜体等格式，发出去的就是用户敲的字），
 * @ 引用项目文件（插入文件标记，发送时写成 @路径）或其他会话（发送时写成 @标题），/ 在行首调出命令：Pigcode 自己的命令，
 * 以及当前 Agent 的内置命令、skill 与自定义命令（插入它们的文字，发给 CLI 展开）。
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
import { matchThreads, THREAD_MENTION_PREFIX, type ComposerThreadOption } from "./composer-threads"
import type { SuggestionItem, SuggestionStore } from "./suggestion-store"

/**
 * 斜杠命令。Pigcode 自己的命令有 run：选中后执行，命令文字从输入框里删掉。
 * Agent 的命令有 insert：选中后换成这段文字（例如 `/compact `），随消息发给 CLI。
 */
export interface ComposerCommand {
  id: string
  label: string
  description?: string | undefined
  keywords?: readonly string[] | undefined
  /** 现在能不能执行；`/` 建议每次更新时判断，返回 false 时不列出。缺省为能。 */
  available?: (() => boolean) | undefined
  run?: (() => void) | undefined
  insert?: string | undefined
  /** 来源：Pigcode 自己的命令（缺省）、Agent 内置命令、skill 与自定义命令。 */
  source?: CommandSource | undefined
  /** 参数提示，例如 `<file>`。 */
  hint?: string | undefined
}

/** `/` 菜单里命令的来源。 */
export type CommandSource = "pigcode" | "builtin" | "skill"

/** 扩展读取的最新配置；用 getter 读取，编辑器不必随 props 重建。 */
export interface ComposerEditorSources {
  placeholder: () => string
  smartPunctuation: () => boolean
  files: () => (() => Promise<readonly string[]>) | undefined
  /** 可以 @ 引用的会话（#81）；没有时 @ 只列文件。 */
  threads: () => readonly ComposerThreadOption[] | undefined
  commands: () => readonly ComposerCommand[]
  /** 当前 Agent 的命令；读一次可能要启动 CLI，由调用方缓存。 */
  agentCommands: () => (() => Promise<readonly ComposerCommand[]>) | undefined
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
  /** 这次 `/` 建议里列出的 Agent 命令；选中时按 id 找回。 */
  let agentListed: readonly ComposerCommand[] = []
  const loadAgentCommands = async (): Promise<readonly ComposerCommand[]> => {
    const source = sources.agentCommands()
    return source ? source().catch(() => []) : []
  }
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
      // 文件写成 @路径；会话写成 @标题，具体是哪个会话随消息另外交给 Host。
      renderText: ({ node }) => {
        const id = String(node.attrs.id ?? "")
        return id.startsWith(THREAD_MENTION_PREFIX)
          ? `@${String(node.attrs.label ?? id)}`
          : `@${id}`
      },
      renderHTML: ({ node, options }) => [
        "span",
        {
          ...options.HTMLAttributes,
          "data-type": "mention",
          "data-id": node.attrs.id,
          "data-kind": String(node.attrs.id ?? "").startsWith(THREAD_MENTION_PREFIX)
            ? "thread"
            : "file",
        },
        `@${String(node.attrs.label ?? node.attrs.id ?? "")}`,
      ],
      suggestions: [
        {
          char: "@",
          pluginKey: FILE_SUGGESTION_KEY,
          // 会话在前（最多 5 个），文件在后：文件可能有几十个，会话放后面就看不到了。
          items: async ({ query }) => [
            ...matchThreads(sources.threads() ?? [], query).map((thread): SuggestionItem => ({
              id: `${THREAD_MENTION_PREFIX}${thread.id}`,
              label: thread.title,
              detail: thread.sameProject ? undefined : thread.projectName,
              archived: thread.archived,
              kind: "thread",
            })),
            ...matchFiles(await loadFiles(), query).map((path): SuggestionItem => ({
              id: path,
              label: path,
              kind: "file",
            })),
          ],
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
          items: async ({ query }) => {
            const own = sources.commands().filter((command) => command.available?.() ?? true)
            agentListed = await loadAgentCommands()
            // 同名时 Pigcode 自己的命令优先；没有查询时 skill 排在 Agent 内置命令前面。
            const all = firstPerLabel([...own, ...ordered(agentListed)])
            return matchByLabel(all, query).map((command): SuggestionItem => ({
              id: command.id,
              label: command.label,
              detail: command.description,
              hint: command.hint,
              source: command.source ?? "pigcode",
              kind: "command",
            }))
          },
          command: ({ editor, range, props }) => {
            // 列表打开期间命令可能已经消失（例如它的插件被停用）：不删用户敲的字，也不执行。
            const selected = [...sources.commands(), ...agentListed].find(
              (command) => command.id === props.id,
            )
            if (!selected) return
            if (selected.insert) {
              editor.chain().focus().insertContentAt(range, `${selected.insert} `).run()
              return
            }
            editor.chain().focus().deleteRange(range).run()
            selected.run?.()
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

/** 把一段纯文本放进编辑器，换行变成软换行。 */
export function setPlainText(editor: Editor, text: string): void {
  const content = text
    .split("\n")
    .flatMap((line, index) => [
      ...(index > 0 ? [{ type: "hardBreak" }] : []),
      ...(line ? [{ type: "text", text: line }] : []),
    ])
  editor.commands.setContent({ type: "doc", content: [{ type: "paragraph", content }] })
  editor.commands.focus("end")
}

/** 每个 label（`/` 名字，不分大小写）只保留第一条命令。 */
export function firstPerLabel(commands: readonly ComposerCommand[]): ComposerCommand[] {
  const seen = new Set<string>()
  return commands.filter((command) => {
    const key = command.label.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 没有查询时的顺序：skill 与自定义命令在前，Agent 内置命令在后。 */
function ordered(commands: readonly ComposerCommand[]): ComposerCommand[] {
  return [
    ...commands.filter((command) => command.source !== "builtin"),
    ...commands.filter((command) => command.source === "builtin"),
  ]
}
