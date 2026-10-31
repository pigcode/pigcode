// 设置插件入口：把 SettingsView 注册到 settings.section slot。
import { createElement } from "react"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"
import { SettingsView, type SettingsViewProps } from "./settings-view"

/** slot 宿主未传 props 时使用的空设置视图，避免插件被单独加载时崩溃。 */
const EMPTY_PROPS: SettingsViewProps = { section: "general" }

/** 注册设置视图；返回注销函数。 */
export function apply(ctx: ClientPluginContext): () => void {
  return ctx.slots.register("settings.section", {
    id: "settings",
    order: 0,
    render: (props: SettingsViewProps) => createElement(SettingsView, props ?? EMPTY_PROPS),
  })
}
