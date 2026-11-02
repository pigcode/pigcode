/** 从 JSONL fixture 回放 SDKMessage。 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ClaudeQueryFn } from "./driver"

/** 构造一个按行回放 fixture 的 queryFn；相对路径以 replay.ts 所在目录为基准。 */
export function replayQuery(file: string): ClaudeQueryFn {
  return () => {
    const path = file.startsWith("/") ? file : join(import.meta.dirname, file)
    const messages = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as SDKMessage)
    return (async function* () {
      for (const message of messages) yield message
    })() as unknown as Query
  }
}
