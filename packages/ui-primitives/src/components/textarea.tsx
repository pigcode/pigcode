/** 多行输入；Base UI 没有 Textarea 原语，沿用原生元素与 pigclaude 类名。 */
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function Textarea({
  className,
  size,
  ...props
}: ComponentProps<"textarea"> & {
  /** 横向内边距与圆角跟同一档的单行输入框一样：默认与 lg 是 8 / 8，md 是 6 / 6。 */
  size?: "md" | "lg" | undefined
}) {
  return <textarea className={cn("textarea", className)} data-size={size} {...props} />
}
