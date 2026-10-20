import { describe, expect, it } from "vitest"
import type { ProviderEvent } from "@pigcode/contracts"
import type { ProviderRuntime } from "./driver"
import { FakeProviderDriver } from "./fake"

describe("fake provider", () => {
  it("streams a deterministic response", async () => {
    const driver = new FakeProviderDriver()
    const session = await driver.createSession({ threadId: "th_1", cwd: "/tmp" })
    const events: string[] = []
    const runtime: ProviderRuntime = {
      signal: new AbortController().signal,
      emit: (event: ProviderEvent) => events.push(event.type),
      requestApproval: async () => "deny",
    }
    await driver.send(session, { text: "hello" }, runtime)
    expect(events).toEqual([
      "run.started",
      "message.delta",
      "message.delta",
      "message.delta",
      "message.delta",
      "message.completed",
      "run.completed",
    ])
  })
})
