/** 基于 Base UI Popover 的浮层组合；弹层自动带上与菜单相同的外框类名。 */
import { Popover as BasePopover } from "@base-ui/react/popover"
import type { ComponentProps } from "react"
import { withBaseClass } from "./base-class"

function Positioner({ className, ...props }: ComponentProps<typeof BasePopover.Positioner>) {
  return (
    <BasePopover.Positioner className={withBaseClass("menu-positioner", className)} {...props} />
  )
}

function Popup({ className, ...props }: ComponentProps<typeof BasePopover.Popup>) {
  return <BasePopover.Popup className={withBaseClass("popup", className)} {...props} />
}

export const Popover = {
  Root: BasePopover.Root,
  Trigger: BasePopover.Trigger,
  Portal: BasePopover.Portal,
  Positioner,
  Popup,
  Title: BasePopover.Title,
  Description: BasePopover.Description,
  Close: BasePopover.Close,
}
