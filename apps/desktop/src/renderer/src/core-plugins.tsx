/** 内置 UI 插件：聊天与设置视图通过同一个 slot registry 注册。 */
import type { SlotRegistry } from "@pigcode/client-runtime"
import { ChatViewContainer, type ChatSlotProps, type CoreDeps, type SettingsSlotProps } from "./app"
import { Suspense, lazy } from "react"

// 设置与插件管理只在打开设置页时加载。
const SettingsContainer = lazy(() =>
  import("./settings-container").then((module) => ({ default: module.SettingsContainer })),
)

/** 注册核心视图；第三方插件也通过同一入口挂载。 */
export function registerCorePlugins(registry: SlotRegistry, deps: CoreDeps): void {
  registry.register<ChatSlotProps>("chat.view", {
    id: "core.chat",
    order: 0,
    render: (props) => <ChatViewContainer deps={deps} {...props} />,
  })
  registry.register<SettingsSlotProps>("settings.section", {
    id: "core.settings",
    order: 0,
    render: (props) => (
      <Suspense fallback={null}>
        <SettingsContainer deps={deps} {...props} />
      </Suspense>
    ),
  })
}
