import type { Context } from "cordis"
import {
  mobileActiveRun,
  mobileRunDelta,
  mobileTimelineMethods as methods,
  mobileTimelineNotice,
  mobileTimelinePage,
  timelinePageBytes,
  timelineTextPreviewLength,
  timelineToolPreviewLength,
  type MobileTimelineContentParams,
  type MobileTimelineEvent,
  type MobileTimelinePage,
  type RpcRequest,
} from "@pigcode/contracts"
import {
  mobileTimelineContentParams,
  mobileTimelineHistoryParams,
  mobileTimelineThreadParams,
} from "@pigcode/contracts"
import { mobileParams, MobileRequestError } from "./request-error"
import { eventBody, preview, timelineEvent } from "./timeline-projection"

export const mobileTimelineRequests: ReadonlySet<string> = new Set([
  methods.subscribe,
  methods.unsubscribe,
  methods.history,
  methods.live,
  methods.content,
])
const maxEvents = 500
const envelopeReserve = 1024

/** A connection has one selected conversation. Its cursors and listeners are private to it. */
export class MobileTimelineSession {
  private threadId: string | undefined
  private stopEvents: (() => void) | undefined
  private stopLive: (() => void) | undefined
  private stopProjects: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    private readonly send: (message: unknown) => void,
  ) {}

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.subscribe:
        return this.subscribe(mobileParams(mobileTimelineThreadParams, request.params))
      case methods.unsubscribe:
        return this.unsubscribe(mobileParams(mobileTimelineThreadParams, request.params))
      case methods.history:
        return this.history(mobileParams(mobileTimelineHistoryParams, request.params))
      case methods.live: {
        const { threadId } = mobileParams(mobileTimelineThreadParams, request.params)
        this.requireThread(threadId)
        return { live: this.snapshot(threadId), through: this.ctx.sessions.latestSeq(threadId) }
      }
      case methods.content:
        return this.content(mobileParams(mobileTimelineContentParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  subscribe({ threadId }: { threadId: string }) {
    this.requireThread(threadId)
    this.close()
    const through = this.ctx.sessions.latestSeq(threadId)
    const live = this.snapshot(threadId)
    const reserve = live ? Buffer.byteLength(JSON.stringify(live)) : 0
    const page = this.window(
      threadId,
      through,
      through + 1,
      true,
      timelinePageBytes - envelopeReserve - reserve,
    )
    let previousSeq = through
    this.threadId = threadId
    this.stopEvents = this.ctx.sessions.subscribe(threadId, (stored) => {
      const event = timelineEvent(stored)
      if (!event) return
      this.send({
        jsonrpc: "2.0",
        method: methods.event,
        params: mobileTimelineNotice.parse({ threadId, previousSeq, event }),
      })
      previousSeq = event.seq
    })
    this.stopLive = this.ctx.sessions.subscribeLive(threadId, (change) => {
      const event = change.event
      const kind =
        event.type === "message.delta"
          ? "text"
          : event.type === "reasoning.delta"
            ? "reasoning"
            : "tool"
      const value = event.type === "tool.outputDelta" ? event.delta : event.text
      this.send({
        jsonrpc: "2.0",
        method: methods.delta,
        params: mobileRunDelta.parse({
          threadId,
          runId: change.runId,
          revision: change.revision,
          kind,
          ...preview(
            value,
            kind === "tool" ? timelineToolPreviewLength : timelineTextPreviewLength,
          ),
          toolId: event.type === "tool.outputDelta" ? event.toolCallId : undefined,
        }),
      })
    })
    this.stopProjects = this.ctx.projects.subscribe(() => {
      if (!this.available(threadId)) this.close()
    })
    return { page, live }
  }

  history({ threadId, through, before }: { threadId: string; through: number; before: number }) {
    this.requireThread(threadId)
    if (through > this.ctx.sessions.latestSeq(threadId) || before > through + 1) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
    return this.window(threadId, through, before, false, timelinePageBytes - envelopeReserve)
  }

  content({ threadId, seq, runId, toolId, field, offset = 0 }: MobileTimelineContentParams) {
    this.requireThread(threadId)
    if ((seq === undefined) === (runId === undefined))
      throw new MobileRequestError("INVALID_PARAMS")
    let body: string | undefined
    if (seq !== undefined) {
      const stored = this.ctx.sessions.get(threadId, seq)
      if (stored) body = eventBody(stored, field)
    } else {
      const live = this.ctx.sessions.liveSnapshot(threadId)
      if (live && live.runId === runId) {
        if (field === "text") body = live.text
        if (field === "reasoning") body = live.reasoning
        if (field === "output" && toolId) body = live.tools.find(({ id }) => id === toolId)?.text
      }
    }
    if (body === undefined) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    const code = body.charCodeAt(offset)
    if (
      offset > body.length ||
      (code >= 0xdc00 &&
        code <= 0xdfff &&
        body.charCodeAt(offset - 1) >= 0xd800 &&
        body.charCodeAt(offset - 1) <= 0xdbff)
    ) {
      throw new MobileRequestError("INVALID_PARAMS")
    }
    const chunk = preview(body.slice(offset), timelineTextPreviewLength)
    return {
      text: chunk.text,
      nextOffset: chunk.truncated ? offset + chunk.text.length : undefined,
    }
  }

  unsubscribe({ threadId }: { threadId: string }): { ok: true } {
    if (this.threadId === threadId) this.close()
    return { ok: true }
  }

  close(): void {
    this.stopEvents?.()
    this.stopLive?.()
    this.stopProjects?.()
    this.stopEvents = this.stopLive = this.stopProjects = undefined
    this.threadId = undefined
  }

  private available(threadId: string): boolean {
    const thread = this.ctx.threads.get(threadId)
    return (
      !!thread &&
      !thread.parentThreadId &&
      this.ctx.projects.list().some(({ id }) => id === thread.projectId)
    )
  }

  private requireThread(threadId: string): void {
    if (!this.available(threadId)) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
  }

  private snapshot(threadId: string) {
    const live = this.ctx.sessions.liveSnapshot(threadId)
    if (!live) return undefined
    const message = preview(live.text, timelineTextPreviewLength)
    const reasoning = preview(live.reasoning, timelineTextPreviewLength)
    return mobileActiveRun.parse({
      runId: live.runId,
      startedAt: live.startedAt,
      revision: live.revision,
      text: message.text,
      textTruncated: message.truncated,
      reasoning: reasoning.text,
      reasoningTruncated: reasoning.truncated,
      step: live.step === undefined ? undefined : preview(live.step, 120).text,
      tools: live.tools
        .slice(-8)
        .map(({ id, text }) => ({ id, ...preview(text, timelineToolPreviewLength) })),
      pending: this.ctx.agents
        .listPendingRequests(threadId)
        .filter((request) => request.runId === live.runId)
        .slice(0, 128)
        .map(({ id, kind }) => ({ id, kind })),
      finishedSteps: live.finishedSteps,
      totalSteps: live.totalSteps,
    })
  }

  private window(
    threadId: string,
    through: number,
    before: number,
    opening: boolean,
    budget: number,
  ): MobileTimelinePage {
    const events: MobileTimelineEvent[] = []
    const runs = new Set<string>()
    let oldest: number | undefined
    let scanned = 0
    let bytes = 0
    let messages = 0
    const userRuns = new Set<string>()
    let more = false
    for (const stored of this.ctx.sessions.readBefore(threadId, through, before, maxEvents + 1)) {
      const event = timelineEvent(stored)
      const key = event?.runId ?? (event ? String(event.seq) : undefined)
      const crossesTurn = key !== undefined && !runs.has(key)
      if (scanned === maxEvents || (crossesTurn && runs.size >= 2 && (opening || messages >= 50))) {
        more = true
        break
      }
      const size = event ? Buffer.byteLength(JSON.stringify(event)) + 1 : 0
      if (bytes + size > budget) {
        more = true
        break
      }
      if (event && key !== undefined) {
        events.push(event)
        runs.add(key)
        if (event.kind === "message.assistant") messages++
        if (
          (event.kind === "message.user" || event.kind === "run.started") &&
          event.text &&
          !userRuns.has(key)
        ) {
          userRuns.add(key)
          messages++
        }
      }
      scanned++
      bytes += size
      oldest = stored.seq
    }
    return mobileTimelinePage.parse({
      events: events.reverse(),
      through,
      nextBefore: more ? oldest : undefined,
    })
  }
}
