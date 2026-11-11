/** 发送一轮时带上还没发出的交接（thread_handoffs 里 pending 的那些）。 */
import { HandoffStore, joinHandoffs, type NewHandoff } from "../storage/handoff-store"
import type { PigcodeDatabase } from "../storage/database"
import { startsWithAgentCommand } from "./agent-command"

/**
 * 取出要拼在这一轮用户消息前的交接，并记成已发。用户消息以 Agent 命令开头时 CLI 只认开头的命令，
 * 这一轮不带，交接留到下一轮（#75）。extra 是这一轮刚记下的交接（例如原生会话接不上时的那份）。
 */
export function handoffForRun(
  db: PigcodeDatabase,
  threadId: string,
  runId: string,
  text: string,
  extra?: NewHandoff | null,
): string | null {
  const store = new HandoffStore(db)
  if (extra) store.create(extra)
  const pending = store.pending(threadId)
  const joined = joinHandoffs(pending)
  if (joined === null || startsWithAgentCommand(text)) return null
  store.markDelivered(
    pending.map((handoff) => handoff.id),
    runId,
    "inline",
  )
  return joined
}
