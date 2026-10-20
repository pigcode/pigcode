/** 内置 UI 插件：聊天与设置视图通过同一个 slot registry 注册。 */
import type { SlotRegistry } from "@pigcode/client-runtime"
import { ChatViewContainer, SettingsContainer, type CoreDeps, type SettingsSlotProps } from "./app"

/** 注册核心视图；第三方插件也通过同一入口挂载。 */
export function registerCorePlugins(registry: SlotRegistry, deps: CoreDeps): void {
  registry.register<undefined>("chat.view", {
    id: "core.chat",
    order: 0,
    render: () => <ChatViewContainer deps={deps} />,
  })
  registry.register<SettingsSlotProps>("settings.section", {
    id: "core.settings",
    order: 0,
    render: (props) => <SettingsContainer deps={deps} {...props} />,
  })
}
