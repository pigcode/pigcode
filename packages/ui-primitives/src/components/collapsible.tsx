/** 基于 Base UI Collapsible 的折叠区组合。 */
import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function CollapsibleRoot({
  className,
  ...props
}: ComponentProps<typeof BaseCollapsible.Root>) {
  return <BaseCollapsible.Root className={className} {...props} />
}

export function CollapsibleTrigger({
  className,
  ...props
}: ComponentProps<typeof BaseCollapsible.Trigger>) {
  return <BaseCollapsible.Trigger className={className} {...props} />
}

export function CollapsiblePanel({
  className,
  ...props
}: ComponentProps<typeof BaseCollapsible.Panel>) {
  return <BaseCollapsible.Panel className={cn("collapsible-content", className)} {...props} />
}

export const Collapsible = {
  Root: CollapsibleRoot,
  Trigger: CollapsibleTrigger,
  Panel: CollapsiblePanel,
}
