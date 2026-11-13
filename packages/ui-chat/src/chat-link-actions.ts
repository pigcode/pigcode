/** 聊天容器提供的链接操作，由各条助手消息共用。 */
import { createContext } from "react"

export interface ChatLinkActions {
  openExternal: (url: string) => void
  showMenu: (url: string, point: { x: number; y: number }) => void
}

export const ChatLinkContext = createContext<ChatLinkActions | undefined>(undefined)
