/** 基于 Base UI Menu 的菜单组合；弹层、菜单项、分隔线与分组标题自动带上 menus.css 的类名。 */
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu"
import { Menu as BaseMenu } from "@base-ui/react/menu"
import type { ComponentProps, MouseEvent } from "react"
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

/** 打开子菜单的一行；右侧可以放当前值和箭头。 */
function SubmenuTrigger({ className, ...props }: ComponentProps<typeof BaseMenu.SubmenuTrigger>) {
  return (
    <BaseMenu.SubmenuTrigger
      className={withBaseClass("menu-item menu-submenu-trigger", className)}
      {...props}
    />
  )
}

function RadioItem({ className, ...props }: ComponentProps<typeof BaseMenu.RadioItem>) {
  return <BaseMenu.RadioItem className={withBaseClass("menu-item", className)} {...props} />
}

function CheckboxItem({ className, ...props }: ComponentProps<typeof BaseMenu.CheckboxItem>) {
  return <BaseMenu.CheckboxItem className={withBaseClass("menu-item", className)} {...props} />
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
  SubmenuRoot: BaseMenu.SubmenuRoot,
  SubmenuTrigger,
  RadioGroup: BaseMenu.RadioGroup,
  RadioItem,
  RadioItemIndicator: BaseMenu.RadioItemIndicator,
  CheckboxItem,
  CheckboxItemIndicator: BaseMenu.CheckboxItemIndicator,
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

/** 鼠标右键贴着指针，键盘触发且没有指针坐标时贴着当前控件。 */
export function contextMenuPoint(
  event: Pick<MouseEvent<HTMLElement>, "clientX" | "clientY" | "currentTarget">,
) {
  if (event.clientX || event.clientY) return { x: event.clientX, y: event.clientY }
  const box = event.currentTarget.getBoundingClientRect()
  return { x: box.left, y: box.bottom }
}

export function nativeContextMenu(run?: (point: { x: number; y: number }) => void) {
  if (!run) return undefined
  return (event: MouseEvent<HTMLElement>) => {
    event.preventDefault()
    run(contextMenuPoint(event))
  }
}
