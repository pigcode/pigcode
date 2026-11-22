import type { Context } from "cordis"

export function subscribeDesktopThread(
  ctx: Context,
  threadId: string,
  cursor: number,
  send: (message: unknown) => void,
) {
  const events = ctx.sessions.read(threadId, cursor)
  const live = ctx.sessions.liveSnapshot(threadId)
  const queued: unknown[] = []
  let ready = false
  let released = false
  const forward = (message: unknown) => {
    if (released) return
    if (ready) send(message)
    else queued.push(message)
  }
  const stopEvents = ctx.sessions.subscribe(threadId, (event) => {
    forward({ jsonrpc: "2.0", method: "thread.event", params: event })
  })
  const stopLive = ctx.sessions.subscribeLive(threadId, ({ event }) => {
    forward({ jsonrpc: "2.0", method: "thread.delta", params: { threadId, event } })
  })
  return {
    afterReply() {
      if (released) return
      ready = true
      for (const message of queued) send(message)
      queued.length = 0
    },
    release() {
      released = true
      queued.length = 0
      stopLive()
      stopEvents()
    },
    result: {
      snapshot: {
        thread: ctx.threads.get(threadId) ?? null,
        runs: [],
        items: [],
        pendingRequests: ctx.agents.listPendingRequests(threadId),
        ...(live ? { live } : {}),
      },
      cursor: events.at(-1)?.seq ?? cursor,
      events,
    },
  }
}
