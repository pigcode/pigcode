/** 纯样式徽标；颜色语义沿用 pigclaude 的 ok/warn/bad/info。 */
import type { ComponentProps } from "react"
import { cn } from "./cn"

export type BadgeVariant = "neutral" | "primary" | "ok" | "warn" | "bad" | "info"

export type BadgeProps = ComponentProps<"span"> & {
  variant?: BadgeVariant
}

export function Badge({ className, variant = "neutral", ...props }: BadgeProps) {
  return <span className={cn("badge", `badge-${variant}`, className)} {...props} />
}
