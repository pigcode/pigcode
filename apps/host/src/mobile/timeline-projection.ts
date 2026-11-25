import {
  imageAttachmentSchema,
  timelineTextPreviewLength,
  timelineToolPreviewLength,
  type ImageAttachmentRef,
  type MobileTimelineEvent,
  type ThreadEvent,
} from "@pigcode/contracts"

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function printable(value: unknown): string | undefined {
  return typeof value === "string" ? value : JSON.stringify(value)
}

/** Character limits are counted in Unicode code points. Offsets elsewhere are UTF-16. */
export function preview(value: string, limit: number): { text: string; truncated: boolean } {
  if (value.length <= limit) return { text: value, truncated: false }
  let end = 0
  let remaining = limit
  for (const character of value) {
    if (remaining-- === 0) break
    end += character.length
  }
  return { text: value.slice(0, end), truncated: end < value.length }
}

export function eventBody(
  event: ThreadEvent,
  field: "text" | "input" | "output" | "reasoning",
): string | undefined {
  const payload = record(event.payload)
  if (payload.parentToolUseId) return undefined
  switch (event.type) {
    case "tool.started":
      return field === "input" ? printable(payload.input) : undefined
    case "tool.completed":
      return field === "output" ? printable(payload.output) : undefined
    case "message.completed":
    case "reasoning.completed":
    case "run.started":
      return field === "text" ? text(payload.text) : undefined
    default:
      return undefined
  }
}

export function timelineEvent(
  event: ThreadEvent,
  includeQueueChanges = false,
  includeRunChanges = false,
  includeAttachments = true,
): MobileTimelineEvent | undefined {
  const payload = record(event.payload)
  if (payload.parentToolUseId) return undefined
  const base = { seq: event.seq, runId: event.runId ?? undefined, createdAt: event.createdAt }
  switch (event.type) {
    case "checkpoint.created":
      return includeRunChanges && event.runId && payload.phase === "final" &&
        !(Array.isArray(payload.changedPaths) && payload.changedPaths.length === 0)
        ? { ...base, kind: "changes" }
        : undefined
    case "queue.changed":
      return includeQueueChanges ? { ...base, kind: "queue.changed" } : undefined
    case "run.queued":
    case "run.completed":
    case "run.interrupted":
      return { ...base, kind: event.type }
    case "run.failed":
      return { ...base, kind: event.type, ...preview(text(payload.message) ?? "", 512) }
    case "run.started":
      return {
        ...base,
        kind: event.type,
        ...preview(text(payload.text) ?? "", timelineTextPreviewLength),
      }
    case "message.completed": {
      const attachments =
        includeAttachments && payload.role === "user"
          ? attachmentRefs(payload.attachments)
          : undefined
      return {
        ...base,
        kind: payload.role === "user" ? "message.user" : "message.assistant",
        ...preview(text(payload.text) ?? "", timelineTextPreviewLength),
        ...(attachments ? { attachments } : {}),
      }
    }
    case "reasoning.completed":
      return {
        ...base,
        kind: "reasoning",
        ...preview(text(payload.text) ?? "", timelineTextPreviewLength),
      }
    case "tool.started":
    case "tool.completed": {
      const itemId = text(payload.toolCallId) ?? text(payload.id)
      if (!itemId) return undefined
      const field = event.type === "tool.started" ? "input" : "output"
      return {
        ...base,
        kind: event.type,
        itemId,
        name: preview(text(payload.name) ?? "工具", 120).text,
        failed: payload.isError === true,
        ...preview(eventBody(event, field) ?? "", timelineToolPreviewLength),
      }
    }
    case "plan.updated": {
      const steps = Array.isArray(payload.plan) ? payload.plan.map(record) : []
      return {
        ...base,
        kind: "plan",
        totalSteps: steps.length,
        finishedSteps: steps.filter((step) => step.status === "completed").length,
      }
    }
    case "file.changed": {
      const name = text(payload.path)
      return name ? { ...base, kind: "file", name: preview(name, 512).text } : undefined
    }
    case "approval.requested":
    case "approval.resolved":
    case "question.requested":
    case "question.answered": {
      const itemId = text(payload.requestId) ?? text(payload.id)
      if (!itemId) return undefined
      const result = requestResult(event.type, payload)
      const toolName =
        event.type === "approval.requested"
          ? (nonEmptyText(payload.toolName) ?? nonEmptyText(payload.name))
          : undefined
      return {
        ...base,
        kind: event.type,
        itemId,
        ...(toolName ? { name: preview(toolName, 120).text } : {}),
        ...(result ? preview(result, 512) : {}),
      }
    }
    case "notice":
      return {
        ...base,
        kind: "notice",
        text: preview(
          text(payload.message) ?? (payload.key === "host.restarted" ? "电脑上的 Pigcode 重启，运行已中断。" : "Agent 提示"),
          512,
        ).text,
      }
    default:
      return undefined
  }
}

function attachmentRefs(value: unknown): ImageAttachmentRef[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const refs: ImageAttachmentRef[] = []
  for (const item of value) {
    const parsed = imageAttachmentSchema.safeParse(item)
    if (parsed.success) refs.push(parsed.data)
  }
  return refs.length > 0 ? refs : undefined
}

function requestResult(type: ThreadEvent["type"], payload: Record<string, unknown>) {
  if (type === "approval.resolved") {
    if (payload.reason === "run-ended") return "审批已失效"
    if (payload.decision === "allow-once") return "已允许一次"
    if (payload.decision === "allow-for-session") return "本会话已允许"
    if (payload.decision === "deny") return "已拒绝"
  }
  if (type === "question.answered") {
    if (payload.reason) return "提问已失效"
    if (Array.isArray(payload.answers)) return "已回答 · " + payload.answers.join(" / ")
  }
  return undefined
}
