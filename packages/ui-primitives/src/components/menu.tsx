/** 基于 Base UI Menu 的菜单组合；右键菜单与普通菜单共用 Item、Separator 等部件。 */
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu"
import { Menu as BaseMenu } from "@base-ui/react/menu"

export const Menu = {
  Root: BaseMenu.Root,
  Trigger: BaseMenu.Trigger,
  Portal: BaseMenu.Portal,
  Positioner: BaseMenu.Positioner,
  Popup: BaseMenu.Popup,
  Item: BaseMenu.Item,
  Separator: BaseMenu.Separator,
  Group: BaseMenu.Group,
  Label: BaseMenu.GroupLabel,
}

/** 在触发区域里右键或长按时，在指针处打开的菜单。 */
export const ContextMenu = {
  Root: BaseContextMenu.Root,
  Trigger: BaseContextMenu.Trigger,
  Portal: BaseContextMenu.Portal,
  Positioner: BaseContextMenu.Positioner,
  Popup: BaseContextMenu.Popup,
  Item: BaseContextMenu.Item,
  Separator: BaseContextMenu.Separator,
}
