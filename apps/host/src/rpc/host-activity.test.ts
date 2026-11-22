import type { ThreadEvent } from "@pigcode/contracts"
import { Context } from "cordis"
import { expect, it, vi } from "vitest"
import type { RunSummary } from "../agents/run-queue"
import { attachHostActivity } from "./host-activity"

it("keeps waiting runs active when another run ends and excludes queued work", async () => {
  const ctx = new Context()
  const waiting: RunSummary = { threadId: "one", runId: "first", status: "waiting-approval" }
  const other: RunSummary = { threadId: "two", runId: "second", status: "running" }
  const queued: RunSummary = { threadId: "three", runId: "third", status: "queued" }
  let runs = [queued]
  let listener: (event: ThreadEvent) => void = () => undefined
  ctx.provide("agents", { listRuns: () => runs } as Context["agents"])
  ctx.provide("sessions", {
    subscribeAll(next) {
      listener = next
      return () => { listener = () => undefined }
    },
  } as Context["sessions"])
  const postMessage = vi.fn()
  attachHostActivity({ postMessage }, ctx)
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "host.running", running: false })
  listener({ type: "run.started" } as ThreadEvent)
  runs = [waiting, other, queued]
  await Promise.resolve()
  expect(postMessage).toHaveBeenLastCalledWith({ type: "host.running", running: true })
  listener({ type: "run.completed" } as ThreadEvent)
  runs = [waiting, queued]
  await Promise.resolve()
  expect(postMessage).toHaveBeenCalledTimes(2)
  listener({ type: "run.interrupted" } as ThreadEvent)
  runs = [queued]
  await Promise.resolve()
  expect(postMessage).toHaveBeenLastCalledWith({ type: "host.running", running: false })
  await ctx.fiber.dispose()
})
