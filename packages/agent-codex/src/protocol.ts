import type { CodexRpcClient } from "./client"

/** Codex app-server 的 NDJSON JSON-RPC 信封。 */
export type CodexIncoming =
  | { kind: "response"; id: number | string; result?: unknown; error?: unknown }
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "request"; id: number | string; method: string; params?: unknown }

/** 按 JSON-RPC 信封形状把一条已解析消息归类；无法识别时返回 unknown。 */
export function classifyCodexMessage(value: unknown): CodexIncoming["kind"] | "unknown" {
  if (typeof value !== "object" || value === null) return "unknown"
  const record = value as Record<string, unknown>
  if (typeof record.method === "string" && "id" in record) return "request"
  if (typeof record.method === "string") return "notification"
  if ("id" in record) return "response"
  return "unknown"
}

/**
 * 把交接作为一条历史消息注入原生 thread（app-server 0.167 起有 thread/inject_items）。
 * 方法不存在（-32601）或请求被拒时返回 false，由调用方拼在用户消息前；这两种情况下都没有注入任何东西。
 */
export async function injectHandoff(
  client: Pick<CodexRpcClient, "request">,
  threadId: string,
  handoff: string,
): Promise<boolean> {
  try {
    await client.request("thread/inject_items", {
      threadId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text: handoff }] }],
    })
    return true
  } catch {
    return false
  }
}
