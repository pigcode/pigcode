/** 基于 Base UI Menu 的菜单组合；弹层、菜单项、分隔线与分组标题自动带上 menus.css 的类名。 */
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu"
import { Menu as BaseMenu } from "@base-ui/react/menu"
import type { ComponentProps } from "react"
import { withBaseClass } from "./base-class"

function Positioner({ className, ...props }: ComponentProps<typeof BaseMenu.Positioner>) {
  return <BaseMenu.Positioner className={withBaseClass("menu-positioner", className)} {...props} />
}

function Popup({ className, ...props }: ComponentProps<typeof BaseMenu.Popup>) {
  return <BaseMenu.Popup className={withBaseClass("popup menu-popup", className)} {...props} />
}

function Item({ className, ...props }: ComponentProps<typeof BaseMenu.Item>) {
  return <BaseMenu.Item className={withBaseClass("menu-item", className)} {...props} />
}

function Separator({ className, ...props }: ComponentProps<typeof BaseMenu.Separator>) {
  return <BaseMenu.Separator className={withBaseClass("menu-sep", className)} {...props} />
}

function Label({ className, ...props }: ComponentProps<typeof BaseMenu.GroupLabel>) {
  return <BaseMenu.GroupLabel className={withBaseClass("menu-label", className)} {...props} />
}

export const Menu = {
  Root: BaseMenu.Root,
  Trigger: BaseMenu.Trigger,
  Portal: BaseMenu.Portal,
  Positioner,
  Popup,
  Item,
  Separator,
  Group: BaseMenu.Group,
  Label,
}

/** 在触发区域里右键或长按时，在指针处打开的菜单；弹层与菜单项和普通菜单是同一组部件。 */
export const ContextMenu = {
  Root: BaseContextMenu.Root,
  Trigger: BaseContextMenu.Trigger,
  Portal: BaseContextMenu.Portal,
  Positioner,
  Popup,
  Item,
  Separator,
}
