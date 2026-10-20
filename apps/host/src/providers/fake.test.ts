import { describe, expect, it } from "vitest"
import { FakeProviderDriver } from "./fake"

describe("fake provider", () => {
  it("streams a deterministic response", async () => {
    const driver = new FakeProviderDriver()
    const session = await driver.createSession({ threadId: "th_1", cwd: "/tmp" })
    const events: string[] = []
    await driver.send(session, { text: "hello" }, (event) => events.push(event.type))
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
