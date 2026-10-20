/** 定义 Renderer 与 Host 之间的版本化 RPC 信封与稳定错误结构。 */
import { z } from "zod"

/** 当前 RPC 协议版本，握手双方必须保持一致。 */
export const PROTOCOL_VERSION = 1 as const

/** Renderer 发往 Host 的请求信封。 */
export const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
})

/** 稳定错误结构，code 由 Host 与插件共同遵守。 */
export const rpcErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional(),
  retryable: z.boolean().optional(),
})

/** 成功响应信封。 */
export const rpcSuccessSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string().min(1),
  result: z.unknown(),
})

/** 失败响应信封。 */
export const rpcFailureSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string().min(1),
  error: rpcErrorSchema,
})

/** 不携带 id 的服务端通知信封。 */
export const rpcNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.string().min(1),
  params: z.unknown().optional(),
})

/** 请求信封的类型。 */
export type RpcRequest = z.infer<typeof rpcRequestSchema>
/** 稳定错误的类型。 */
export type RpcError = z.infer<typeof rpcErrorSchema>
/** 成功响应的类型。 */
export type RpcSuccess = z.infer<typeof rpcSuccessSchema>
/** 失败响应的类型。 */
export type RpcFailure = z.infer<typeof rpcFailureSchema>
/** 通知信封的类型。 */
export type RpcNotification = z.infer<typeof rpcNotificationSchema>

/** 解析请求；非法信封直接抛错，调用方负责转换成 RpcFailure。 */
export function parseRpcRequest(value: unknown): RpcRequest {
  return rpcRequestSchema.parse(value)
}
