/** 用户与助手消息结构，沿用 pigclaude 的 msg-user / msg-ai 类名。 */
import type { ReactNode } from "react"

/** 用户消息右对齐气泡。 */
export function UserMessage({ text }: { text: string }) {
  return <div className="msg-user">{text}</div>
}

/** 助手消息纵向内容容器。 */
export function AssistantMessage({ children }: { children: ReactNode }) {
  return <div className="msg-ai">{children}</div>
}

/** 把多段文本拆成段落；单段内的换行由 CSS 保留。 */
export function MessageText({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/)
  return (
    <>
      {paragraphs.map((paragraph, index) => (
        <p key={index}>{paragraph}</p>
      ))}
    </>
  )
}
