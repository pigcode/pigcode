/** 助手消息链接把打开和右键操作交给聊天容器。 */
import { useContext, type ReactNode } from "react"
import { contextMenuPoint } from "@pigcode/ui-primitives"
import { ChatLinkContext } from "./chat-link-actions"

export function MarkdownLink({ href, children }: { href: string; children: ReactNode }) {
  const actions = useContext(ChatLinkContext)
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={
        actions &&
        ((event) => {
          event.preventDefault()
          actions.openExternal(href)
        })
      }
      onAuxClick={
        actions &&
        ((event) => {
          if (event.button !== 1) return
          event.preventDefault()
          actions.openExternal(href)
        })
      }
      onContextMenu={
        actions &&
        ((event) => {
          const selection = event.currentTarget.ownerDocument.getSelection()
          if (
            selection &&
            !selection.isCollapsed &&
            selection.containsNode(event.currentTarget, true)
          )
            return
          event.preventDefault()
          event.stopPropagation()
          actions.showMenu(href, contextMenuPoint(event))
        })
      }
    >
      {children}
    </a>
  )
}
