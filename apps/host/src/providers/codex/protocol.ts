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
