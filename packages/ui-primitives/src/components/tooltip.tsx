/** 基于 Base UI Tooltip 的提示组合；提示气泡自动带上统一的类名。 */
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip"
import type { ComponentProps } from "react"
import { withBaseClass } from "./base-class"

function Positioner({ className, ...props }: ComponentProps<typeof BaseTooltip.Positioner>) {
  return (
    <BaseTooltip.Positioner className={withBaseClass("tip-positioner", className)} {...props} />
  )
}

function Popup({ className, ...props }: ComponentProps<typeof BaseTooltip.Popup>) {
  return <BaseTooltip.Popup className={withBaseClass("tip-popup", className)} {...props} />
}

export const Tooltip = {
  Provider: BaseTooltip.Provider,
  Root: BaseTooltip.Root,
  Trigger: BaseTooltip.Trigger,
  Portal: BaseTooltip.Portal,
  Positioner,
  Popup,
}
