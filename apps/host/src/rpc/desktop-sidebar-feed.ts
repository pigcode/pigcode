import type { Context } from "cordis"
import type { ThreadFeed } from "./thread-feed"

/** The local renderer receives the full records required by its workspace UI. */
export function subscribeDesktopSidebar(
  ctx: Context,
  feed: ThreadFeed,
  send: (message: unknown) => void,
): () => void {
  const stopThreads = feed.subscribe((thread) => {
    send({ jsonrpc: "2.0", method: "thread.changed", params: thread })
  })
  const projects = ctx.get("projects")
  const stopProjects = projects?.subscribe(() => {
    send({ jsonrpc: "2.0", method: "project.changed", params: projects.list() })
  })
  return () => {
    stopThreads()
    stopProjects?.()
  }
}
