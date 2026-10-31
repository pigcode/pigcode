// 插件管理插件入口：注册设置分区和侧栏底部的插件入口。
import { createElement } from "react"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"
import { ListRow, useLocale } from "@pigcode/ui-primitives"
import { PluginManagerView, type PluginManagerViewProps } from "./plugin-manager-view"

/** slot 宿主未传 props 时使用的空插件管理视图。 */
const EMPTY_PROPS: PluginManagerViewProps = {
  plugins: [],
  onInstall: async () => undefined,
  onEnable: async () => undefined,
  onDisable: async () => undefined,
  onRefresh: async () => undefined,
}

/** 侧栏入口的 props；宿主可注入打开插件管理的回调。 */
interface PluginEntryProps {
  onOpen?: (() => void) | undefined
}

/** 侧栏底部的插件入口按钮；用 createElement 保持本文件为 .ts。 */
function PluginEntry({ onOpen }: PluginEntryProps) {
  const { t } = useLocale()
  return createElement(ListRow, {
    render: createElement("button", { type: "button" }),
    className: "nav-item",
    onClick: onOpen,
    title: t("plugins.open"),
  })
}

/** 注册插件管理视图和入口；返回注销函数。 */
export function apply(ctx: ClientPluginContext): () => void {
  const disposeSection = ctx.slots.register("settings.section", {
    id: "plugins",
    order: 10,
    render: (props: PluginManagerViewProps) =>
      createElement(PluginManagerView, props ?? EMPTY_PROPS),
  })
  const disposeAction = ctx.slots.register("sidebar.footer.action", {
    id: "plugins",
    order: 10,
    render: (props: PluginEntryProps) => createElement(PluginEntry, props ?? {}),
  })
  return () => {
    disposeSection()
    disposeAction()
  }
}
