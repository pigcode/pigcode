import { registerNativeAcp } from "@pigcode/acp-runtime"
import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { fx } from "./driver"

export const name = "agent-fx"
export const inject = ["agents"]
export function apply(ctx: PluginHostContext) {
  registerNativeAcp(ctx, fx)
}
