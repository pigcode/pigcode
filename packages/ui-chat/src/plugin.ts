/** 聊天视图插件入口：把 ChatView 注册到 chat.view slot。 */
import { createElement } from "react"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"
import { ChatView, type ChatViewProps } from "./chat-view"

/** slot 宿主未传 props 时使用的空视图，避免插件被单独加载时崩溃。 */
const EMPTY_PROPS: ChatViewProps = {
  events: [],
  onStart: () => undefined,
  onInterrupt: () => undefined,
  onApproval: () => undefined,
}

/** 注册聊天视图；返回注销函数。 */
export function apply(ctx: ClientPluginContext): () => void {
  return ctx.slots.register("chat.view", {
    id: "chat",
    order: 0,
    render: (props: ChatViewProps) => createElement(ChatView, props ?? EMPTY_PROPS),
  })
}
