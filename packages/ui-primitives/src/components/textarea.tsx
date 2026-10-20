/** 多行输入；Base UI 没有 Textarea 原语，沿用原生元素与 pigclaude 类名。 */
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={cn("textarea", className)} {...props} />
}
