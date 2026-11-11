/**
 * 输入框里 @ 引用会话（#81）：@ 菜单里除了文件还列出会话，选中后插入一个会话标记，发送时文字里写成
 * `@会话标题`，同时作为结构化引用交给 Host，Host 据此给 agent 附上那个会话的摘要和读取方法。
 */
import type { Editor, JSONContent } from "@tiptap/react"

/** @ 菜单里可以引用的一个会话。 */
export interface ComposerThreadOption {
  id: string
  title: string
  /** 所属项目的名字；和当前项目不同时显示出来。 */
  projectName?: string | undefined
  /** 和当前输入框是同一个项目。 */
  sameProject: boolean
  archived: boolean
}

/** 随消息发出的引用。 */
export interface ComposerReference {
  kind: "thread"
  threadId: string
  title: string
}

/** 会话标记的 id 前缀：和文件标记共用 Mention 节点，靠前缀区分。 */
export const THREAD_MENTION_PREFIX = "thread:"

/** @ 菜单里最多列几个会话；会话排在文件前面，多了会把文件挤出视野。 */
const THREAD_LIMIT = 5

/**
 * 挑出要列的会话：没输入时只列当前项目、没归档的（调用方已按最近活动排好）；输入了就在全部会话里按标题找，
 * 包括其他项目和已归档的。标题按子串匹配，不做模糊匹配，免得敲文件名时冒出不相干的会话。
 */
export function matchThreads(
  options: readonly ComposerThreadOption[],
  query: string,
): ComposerThreadOption[] {
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? options.filter((option) => option.title.toLowerCase().includes(needle))
    : options.filter((option) => option.sameProject && !option.archived)
  return shown.slice(0, THREAD_LIMIT)
}

/** 输入框里引用了哪些会话；同一个会话引用多次只算一次。 */
export function editorReferences(editor: Editor): ComposerReference[] {
  const found = new Map<string, ComposerReference>()
  const walk = (node: JSONContent): void => {
    if (node.type === "mention") {
      const id = String(node.attrs?.id ?? "")
      if (id.startsWith(THREAD_MENTION_PREFIX)) {
        const threadId = id.slice(THREAD_MENTION_PREFIX.length)
        if (!found.has(threadId)) {
          found.set(threadId, {
            kind: "thread",
            threadId,
            title: String(node.attrs?.label ?? threadId),
          })
        }
      }
    }
    for (const child of node.content ?? []) walk(child)
  }
  walk(editor.getJSON())
  return [...found.values()]
}
