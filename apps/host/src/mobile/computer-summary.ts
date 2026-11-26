/**
 * 手机端跨电脑汇总处理器：
 * - 单次 RPC 计算全量未归档主会话的互斥分类计数（attention / error / unread / working / total）；
 * - 返回按紧急度（待处理 > 出错 > 未读）与活跃时间排序的精简待看列表，严格脱敏 pendingPreview；
 * - 同时受条目上限（50）与 48 KiB JSON 字节预算（含 JSON-RPC 封包）双重限制。
 */
import type { Context } from "cordis"
import {
  mobileComputerSummaryResultSchema,
  mobileSidebarLabelLimit,
  mobileSummaryMaxItems,
  mobileSummaryMethods,
  mobileSummaryParamsSchema,
  mobileSummaryPreviewLimit,
  type MobileComputerSummaryResult,
  type MobileSummaryCounts,
  type MobileSummaryItem,
  type PendingRequest,
  type RpcRequest,
  type ThreadStatus,
} from "@pigcode/contracts"
import { fingerprint } from "./paired-devices"
import { mobileParams as params, MobileRequestError } from "./request-error"
import type { MobileSession } from "./sidebar-domains"

export const mobileSummaryRequests: ReadonlySet<string> = new Set(
  Object.values(mobileSummaryMethods),
)

const SUMMARY_JSON_BUDGET_BYTES = 48 * 1024
const COMPUTER_NAME_LIMIT = 80

type SummaryBucket = "attention" | "error" | "working" | "unread" | "done"

function classifyThread(status: ThreadStatus, unread: boolean): SummaryBucket {
  if (status === "waiting-approval") return "attention"
  if (status === "failed") return "error"
  if (status === "running" || status === "queued") return "working"
  return unread ? "unread" : "done"
}

function truncateLabel(text: string, limit: number): string {
  if (text.length <= limit) return text
  const prefix = text.slice(0, limit - 1)
  return prefix.replace(/[\uD800-\uDBFF]$/, "") + "…"
}

function displayLabel(text: string): string {
  return truncateLabel(text, mobileSidebarLabelLimit)
}

function sanitizeComputerName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return "Pigcode"
  return truncateLabel(trimmed, COMPUTER_NAME_LIMIT)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function cleanSingleLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length > 0 ? collapsed : undefined
}

function sanitizePreview(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const collapsed = raw.replace(/\s+/g, " ").trim()
  if (!collapsed) return undefined
  if (collapsed.length <= mobileSummaryPreviewLimit) return collapsed
  const prefix = collapsed.slice(0, mobileSummaryPreviewLimit - 1).trimEnd()
  return prefix.replace(/[\uD800-\uDBFF]$/, "") + "…"
}

/** 仅提取人类可读的短标题或首个问题正文，绝不暴露原始 bash 命令或 JSON input。 */
function extractPendingPreview(request: PendingRequest): string | undefined {
  const payload = asRecord(request.payload)
  if (request.kind === "approval") {
    const toolName = cleanSingleLine(payload.toolName)
    if (toolName === "ExitPlanMode") return sanitizePreview("计划审批")
    return sanitizePreview(
      cleanSingleLine(payload.title) ?? cleanSingleLine(payload.displayName) ?? toolName,
    )
  }
  const questions = Array.isArray(payload.questions) ? payload.questions : []
  const first = asRecord(questions[0])
  return sanitizePreview(cleanSingleLine(first.question) ?? cleanSingleLine(first.header))
}

interface RankedSummaryItem {
  rank: 0 | 1 | 2
  updatedMs: number
  item: MobileSummaryItem
}

export class MobileComputerSummary {
  constructor(
    private readonly ctx: Context,
    private readonly session: MobileSession,
    private readonly requirePairedDevice: () => void,
  ) {}

  dispatch(request: RpcRequest): MobileComputerSummaryResult {
    if (request.method !== mobileSummaryMethods.summary) {
      throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
    this.requirePairedDevice()
    params(mobileSummaryParamsSchema, request.params)

    const projectNames = new Map<string, string>()
    for (const project of this.ctx.projects.list()) {
      projectNames.set(project.id, displayLabel(project.name))
    }

    const agentNames = new Map<string, string>()
    for (const agent of this.ctx.agents.list()) {
      const name = agent.displayName.trim()
      if (name) agentNames.set(agent.id, displayLabel(name))
    }

    const counts: MobileSummaryCounts = {
      attention: 0,
      error: 0,
      unread: 0,
      working: 0,
      total: 0,
    }
    const candidates: RankedSummaryItem[] = []

    for (const thread of this.ctx.threads.list()) {
      if (thread.parentThreadId || thread.archivedAt !== null) continue
      const projectName = projectNames.get(thread.projectId)
      if (!projectName) continue

      counts.total += 1
      const status: ThreadStatus = thread.status ?? "idle"
      const unread = thread.unread === true
      const bucket = classifyThread(status, unread)

      if (bucket === "attention") counts.attention += 1
      else if (bucket === "error") counts.error += 1
      else if (bucket === "working") counts.working += 1
      else if (bucket === "unread") counts.unread += 1

      if (bucket !== "attention" && bucket !== "error" && bucket !== "unread") {
        continue
      }

      let pendingKind: PendingRequest["kind"] | undefined
      let pendingPreview: string | undefined
      if (status === "waiting-approval") {
        const pending = this.ctx.agents
          .listPendingRequests(thread.id)
          .filter(({ runId }) => runId === thread.lastRunId)
        const chosen = pending.find(({ kind }) => kind === "approval") ?? pending[0]
        if (chosen) {
          pendingKind = chosen.kind
          pendingPreview = extractPendingPreview(chosen)
        }
      }

      const agentName = agentNames.get(thread.lastAgentId ?? thread.defaultAgentId)
      const item: MobileSummaryItem = {
        threadId: thread.id,
        projectId: thread.projectId,
        projectName,
        title: displayLabel(thread.title),
        updatedAt: thread.updatedAt,
        status,
        ...(pendingKind ? { pendingKind } : {}),
        ...(pendingPreview ? { pendingPreview } : {}),
        unread,
        pinned: thread.pinned === true,
        ...(agentName ? { agentName } : {}),
      }

      const rank: 0 | 1 | 2 = bucket === "attention" ? 0 : bucket === "error" ? 1 : 2
      candidates.push({
        rank,
        updatedMs: Date.parse(thread.updatedAt),
        item,
      })
    }

    candidates.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank
      if (a.updatedMs !== b.updatedMs) return b.updatedMs - a.updatedMs
      if (a.item.threadId < b.item.threadId) return -1
      if (a.item.threadId > b.item.threadId) return 1
      return 0
    })

    const computerId = fingerprint(this.session.computerKey)
    const computerName = sanitizeComputerName(this.session.computerName)
    const syncedAt = new Date().toISOString()

    // 使用 truncated: false 计算最宽封包开销，确保最终 JSON-RPC 响应严格不超 48 KiB。
    let usedBytes = Buffer.byteLength(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          computerId,
          computerName,
          syncedAt,
          counts,
          items: [],
          truncated: false,
        },
      }),
      "utf8",
    )

    const items: MobileSummaryItem[] = []
    let truncated = false
    for (const { item } of candidates) {
      if (items.length >= mobileSummaryMaxItems) {
        truncated = true
        break
      }
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length > 0 ? 1 : 0)
      if (usedBytes + itemBytes > SUMMARY_JSON_BUDGET_BYTES) {
        truncated = true
        break
      }
      items.push(item)
      usedBytes += itemBytes
    }

    return mobileComputerSummaryResultSchema.parse({
      computerId,
      computerName,
      syncedAt,
      counts,
      items,
      truncated,
    })
  }
}
