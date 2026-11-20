import { registerNativeAcp } from "@pigcode/acp-runtime"
import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { grok } from "./driver"

export const name = "agent-grok"
export const inject = ["agents"]
export function apply(ctx: PluginHostContext) {
  registerNativeAcp(ctx, grok)
}
