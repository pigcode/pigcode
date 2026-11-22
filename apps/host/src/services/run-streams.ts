import type { AgentEvent, ThreadEvent } from "@pigcode/contracts"

export type LiveAgentDelta = Extract<
  AgentEvent,
  { type: "message.delta" | "reasoning.delta" | "tool.outputDelta" }
>
export interface RunDelta {
  threadId: string
  runId: string
  revision: number
  event: LiveAgentDelta
}

interface RunStream {
  runId: string
  startedAt: string
  revision: number
  text: string
  reasoning: string
  tools: Map<string, string>
  step?: string
  finishedSteps?: number
  totalSteps?: number
}

export interface LiveRunRecord extends Omit<RunStream, "tools"> {
  tools: Array<{ id: string; text: string }>
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

/** The unfinished portions of a run are discarded when their durable events arrive. */
export class RunStreams {
  private readonly runs = new Map<string, RunStream>()
  private readonly listeners = new Map<string, Set<(delta: RunDelta) => void>>()

  record(event: ThreadEvent): void {
    if (event.type === "run.started" && event.runId) {
      this.runs.set(event.threadId, {
        runId: event.runId,
        startedAt: event.createdAt,
        revision: 0,
        text: "",
        reasoning: "",
        tools: new Map(),
      })
      return
    }
    const run = this.runs.get(event.threadId)
    if (!run || run.runId !== event.runId) return
    const payload = object(event.payload)
    switch (event.type) {
      case "message.completed":
        if (payload.role !== "user" && !payload.parentToolUseId) run.text = ""
        break
      case "reasoning.completed":
        if (!payload.parentToolUseId) run.reasoning = ""
        break
      case "tool.started":
        if (!payload.parentToolUseId && typeof payload.name === "string") run.step = payload.name
        break
      case "tool.completed":
        if (typeof payload.toolCallId === "string") run.tools.delete(payload.toolCallId)
        break
      case "plan.updated": {
        const steps = Array.isArray(payload.plan) ? payload.plan.map(object) : []
        run.totalSteps = steps.length
        run.finishedSteps = steps.filter((step) => step.status === "completed").length
        break
      }
      case "run.completed":
      case "run.failed":
      case "run.interrupted":
        this.runs.delete(event.threadId)
        break
    }
  }

  emit(threadId: string, runId: string, event: LiveAgentDelta): void {
    const run = this.runs.get(threadId)
    if (!run || run.runId !== runId || event.parentToolUseId !== undefined) return
    switch (event.type) {
      case "message.delta":
        run.text += event.text
        run.step = "正在回答"
        break
      case "reasoning.delta":
        run.reasoning += event.text
        run.step = "正在思考"
        break
      case "tool.outputDelta":
        run.tools.set(event.toolCallId, (run.tools.get(event.toolCallId) ?? "") + event.delta)
        break
    }
    const delta = { threadId, runId, revision: ++run.revision, event }
    for (const listener of [...(this.listeners.get(threadId) ?? [])]) listener(delta)
  }

  snapshot(threadId: string): LiveRunRecord | undefined {
    const run = this.runs.get(threadId)
    if (!run) return undefined
    return { ...run, tools: [...run.tools].map(([id, text]) => ({ id, text })) }
  }

  subscribe(threadId: string, listener: (delta: RunDelta) => void): () => void {
    const set = this.listeners.get(threadId) ?? new Set()
    this.listeners.set(threadId, set)
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(threadId)
    }
  }

  clear(): void {
    this.runs.clear()
    this.listeners.clear()
  }
}
