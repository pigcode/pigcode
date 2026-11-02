/** 把 Host 交来的插件工具接成 Claude Agent SDK 的进程内 MCP server。 */
import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk"
import { toolResultContent, type SessionMcp } from "@pigcode/plugin-sdk"
import { z } from "zod"

/** 用会话的工具表与调用入口建 server；工具表为空时返回 null。 */
export function claudeMcpServer(mcp: SessionMcp): McpSdkServerConfigWithInstance | null {
  if (mcp.tools.length === 0) return null
  return createSdkMcpServer({
    name: "pigcode",
    version: "0.1.0",
    tools: mcp.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: shapeFromJsonSchema(tool.inputSchema),
      handler: async (input: unknown) => {
        try {
          return toolResultContent(await mcp.callTool(tool.name, input))
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          }
        }
      },
    })),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** 把工具声明的 JSON Schema 转成 SDK 需要的 zod raw shape。 */
export function shapeFromJsonSchema(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  )
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const [key, value] of Object.entries(properties)) {
    let field = zodForSchema(value)
    const description =
      isRecord(value) && typeof value.description === "string" ? value.description : undefined
    if (description) field = field.describe(description)
    shape[key] = required.has(key) ? field : field.optional()
  }
  return shape
}

/** 支持 JSON Schema 的常用标量/数组/对象类型；未知类型退化为 unknown。 */
function zodForSchema(schema: unknown): z.ZodTypeAny {
  if (!isRecord(schema)) return z.unknown()
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((value): value is string => typeof value === "string")
    if (values.length === schema.enum.length && values.length > 0) {
      return z.enum(values as [string, ...string[]])
    }
  }
  switch (schema.type) {
    case "string":
      return z.string()
    case "number":
      return z.number()
    case "integer":
      return z.number().int()
    case "boolean":
      return z.boolean()
    case "array":
      return z.array(zodForSchema(schema.items))
    case "object":
      return z.object(shapeFromJsonSchema(schema)).loose()
    default:
      return z.unknown()
  }
}
