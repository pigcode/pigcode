/** 示例 Capability 插件：通过 MCP 向模型暴露当前时间；时间线里的显示在 client.ts。 */
import type { PluginHostContext } from "@pigcode/plugin-sdk"

export const name = "capability-clock"
export const inject = ["mcp"]

export function apply(ctx: PluginHostContext): void {
  // ctx.effect 保证插件停用/卸载时注销工具；工具随插件一起消失。
  ctx.effect(() =>
    ctx.mcp.registerTool(
      "pigcode-capability-clock",
      {
        name: "clock_now",
        description: "Return the current ISO time",
        inputSchema: { type: "object", properties: {} },
      },
      async () => ({ now: new Date().toISOString() }),
    ),
  )
}
