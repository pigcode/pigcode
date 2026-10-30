/** 基于 Base UI Select 的下拉选择组合；弹层与选项和菜单用同一套类名。 */
import { Select as BaseSelect } from "@base-ui/react/select"
import type { ComponentProps } from "react"
import { withBaseClass } from "./base-class"

function Positioner({ className, ...props }: ComponentProps<typeof BaseSelect.Positioner>) {
  return (
    <BaseSelect.Positioner className={withBaseClass("menu-positioner", className)} {...props} />
  )
}

function Popup({ className, ...props }: ComponentProps<typeof BaseSelect.Popup>) {
  return <BaseSelect.Popup className={withBaseClass("popup menu-popup", className)} {...props} />
}

function Item({ className, ...props }: ComponentProps<typeof BaseSelect.Item>) {
  return <BaseSelect.Item className={withBaseClass("menu-item", className)} {...props} />
}

function Separator({ className, ...props }: ComponentProps<typeof BaseSelect.Separator>) {
  return <BaseSelect.Separator className={withBaseClass("menu-sep", className)} {...props} />
}

export const Select = {
  Root: BaseSelect.Root,
  Label: BaseSelect.Label,
  Trigger: BaseSelect.Trigger,
  Value: BaseSelect.Value,
  Icon: BaseSelect.Icon,
  Portal: BaseSelect.Portal,
  Positioner,
  Popup,
  List: BaseSelect.List,
  Item,
  ItemText: BaseSelect.ItemText,
  ItemIndicator: BaseSelect.ItemIndicator,
  Separator,
}
