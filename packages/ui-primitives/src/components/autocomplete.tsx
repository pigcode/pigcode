/** 自由输入和可搜索的候选列表使用与 Input、Select 相同的样式。 */
import { Autocomplete as BaseAutocomplete } from "@base-ui/react/autocomplete"
import type { ComponentProps } from "react"
import { withBaseClass } from "./base-class"

function Input({ className, ...props }: ComponentProps<typeof BaseAutocomplete.Input>) {
  return <BaseAutocomplete.Input className={withBaseClass("input", className)} {...props} />
}

function Positioner({ className, ...props }: ComponentProps<typeof BaseAutocomplete.Positioner>) {
  return (
    <BaseAutocomplete.Positioner
      className={withBaseClass("menu-positioner", className)}
      {...props}
    />
  )
}

function Popup({ className, ...props }: ComponentProps<typeof BaseAutocomplete.Popup>) {
  return (
    <BaseAutocomplete.Popup className={withBaseClass("popup menu-popup", className)} {...props} />
  )
}

function Item({ className, ...props }: ComponentProps<typeof BaseAutocomplete.Item>) {
  return <BaseAutocomplete.Item className={withBaseClass("menu-item", className)} {...props} />
}

export const Autocomplete = {
  Root: BaseAutocomplete.Root,
  InputGroup: BaseAutocomplete.InputGroup,
  Input,
  Trigger: BaseAutocomplete.Trigger,
  Portal: BaseAutocomplete.Portal,
  Positioner,
  Popup,
  List: BaseAutocomplete.List,
  Group: BaseAutocomplete.Group,
  GroupLabel: BaseAutocomplete.GroupLabel,
  Collection: BaseAutocomplete.Collection,
  Empty: BaseAutocomplete.Empty,
  Item,
}
