import { describe, expect, it, vi } from "vitest"
import { CodexDriver } from "./driver"
import { ScriptedTransport, messageOf } from "./scripted-transport"

vi.mock("./cli-update", () => ({
  prepareCodexCliUpdate: async (_settings: unknown, onUpdated: () => void) => ({
    target: "codex",
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    available: true,
    command: "test updater",
    reason: null,
    run: async () => onUpdated(),
    verify: async () => "2.0.0",
  }),
}))

describe("Codex CLI updates", () => {
  it("resumes the conversation using a new app-server after updating", async () => {
    const transports: ScriptedTransport[] = []
    const driver = new CodexDriver({
      transportFactory: () => {
        const transport = new ScriptedTransport({ nativeThreadId: "native-thread" })
        transports.push(transport)
        return transport
      },
    })
    const first = await driver.createSession({
      threadId: "thread",
      cwd: "/tmp",
      sessionId: "session",
    })
    const update = await driver.prepareCliUpdate({})
    await update.run!({ signal: new AbortController().signal, onOutput: () => undefined })
    const resumed = await driver.createSession({
      threadId: "thread",
      cwd: "/tmp",
      sessionId: first.id,
      nativeSessionId: first.nativeSessionId,
    })
    expect(transports).toHaveLength(2)
    expect(transports[0]?.closed).toBe(true)
    expect(messageOf(transports[1]!, "thread/resume")?.params).toMatchObject({
      threadId: "native-thread",
    })
    expect(resumed.nativeSessionId).toBe("native-thread")
    await driver.dispose(resumed)
  })
})
