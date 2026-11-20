import { registerNativeAcp } from "@pigcode/acp-runtime"
import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { kiro } from "./driver"

export const name = "agent-kiro"
export const inject = ["agents"]
export function apply(ctx: PluginHostContext) {
  registerNativeAcp(ctx, kiro)
}
