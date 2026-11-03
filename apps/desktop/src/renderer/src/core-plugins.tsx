/** 内置 UI 插件：聊天视图通过 slot registry 注册。设置页在设置页扩展点上（builtin-settings-pages）。 */
import type { SlotRegistry } from "@pigcode/client-runtime"
import { ChatViewContainer, type ChatSlotProps, type CoreDeps } from "./app"

/** 注册核心视图；第三方插件也通过同一入口挂载。 */
export function registerCorePlugins(registry: SlotRegistry, deps: CoreDeps): void {
  registry.register<ChatSlotProps>("chat.view", {
    id: "core.chat",
    order: 0,
    render: (props) => <ChatViewContainer deps={deps} {...props} />,
  })
}
