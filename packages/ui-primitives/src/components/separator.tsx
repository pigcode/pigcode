/** 基于 Base UI Separator 的分隔线。 */
import { Separator as BaseSeparator } from "@base-ui/react/separator"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function Separator({ className, ...props }: ComponentProps<typeof BaseSeparator>) {
  return <BaseSeparator className={cn("ui-separator", className)} {...props} />
}
