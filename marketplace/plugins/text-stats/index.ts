import type { PluginHostContext } from "@pigcode/plugin-sdk"
import { countText } from "./count.ts"

export const name = "@pigcode/text-stats"
export const inject = ["mcp"]

export function apply(ctx: PluginHostContext): void {
  ctx.effect(() =>
    ctx.mcp.registerTool(
      name,
      {
        name: "text_stats",
        description:
          "Count words, Unicode code points, lines and UTF-8 bytes in a supplied string.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
      async (input) => {
        const text = (input as { text?: unknown } | null)?.text
        if (typeof text !== "string") throw new Error("text must be a string")
        return countText(text)
      },
    ),
  )
}
