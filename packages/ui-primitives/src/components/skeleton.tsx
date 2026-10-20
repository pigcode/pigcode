/** 纯样式骨架屏。 */
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("skeleton", className)} {...props} />
}
