/** 多行输入；Base UI 没有 Textarea 原语，沿用原生元素与 pigclaude 类名。 */
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function Textarea({
  className,
  size,
  ...props
}: ComponentProps<"textarea"> & {
  /** lg 与同组的 32 px、36 px 单行输入共用横向内边距与圆角。 */
  size?: "md" | "lg" | undefined
}) {
  return <textarea className={cn("textarea", className)} data-size={size} {...props} />
}
