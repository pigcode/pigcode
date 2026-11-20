import { expect, it } from "vitest"
import type { AgentInstanceContext, CreateSessionInput } from "@pigcode/plugin-sdk"
import { NativeAgentDriver, nativeFeatures, type NativeSession } from "./index"

function gate() {
  let resolve!: () => void
  const wait = new Promise<void>((done) => {
    resolve = done
  })
  return { wait, resolve }
}

it("waits for native interruption and client closure before reopening the same native conversation under another Pigcode handle", async () => {
  const stopping = gate(),
    closing = gate(),
    closed = gate(),
    started = gate()
  let launches = 0
  const log: string[] = []
  class Driver extends NativeAgentDriver {
    readonly id = "test"
    readonly displayName = "test"
    readonly executionModes = { plan: false }
    readonly features = nativeFeatures
    async detect() {
      return { installed: true, authenticated: null, version: null }
    }
    async listModels() {
      return []
    }
    protected async open(input: CreateSessionInput): Promise<NativeSession> {
      launches++
      const sequence = launches
      log.push("open " + input.instance?.instanceId)
      return {
        nativeId: input.nativeSessionId ?? "native",
        send: async (_input, runtime) => {
          started.resolve()
          await new Promise<void>((resolve) =>
            runtime.signal.addEventListener("abort", () => resolve(), { once: true }),
          )
        },
        interrupt: async () => {
          log.push("interrupt")
          await stopping.wait
          log.push("interrupted")
        },
        close: async () => {
          if (sequence === 1) {
            closing.resolve()
            await closed.wait
            log.push("closed")
          }
        },
      }
    }
  }
  const scope = (id: string): AgentInstanceContext => ({
    instanceId: id,
    dataDir: id,
    sharedDir: "shared",
    invalidate() {},
  })
  const driver = new Driver()
  const input = { threadId: "thread", cwd: process.cwd(), instance: scope("one") }
  try {
    const first = await driver.createSession(input)
    const run = driver.send(
      first,
      { text: "first" },
      { signal: new AbortController().signal, emit() {}, requestApproval: async () => "deny" },
    )
    await started.wait
    const stop = driver.interrupt(first)
    const second = driver.createSession({
      ...input,
      sessionId: "another-handle",
      nativeSessionId: first.nativeSessionId,
    })
    const other = await driver.createSession({
      ...input,
      instance: scope("two"),
      sessionId: "independent",
      nativeSessionId: first.nativeSessionId,
    })
    expect(log).toEqual(["open one", "interrupt", "open two"])
    await driver.dispose(other)
    stopping.resolve()
    await closing.wait
    expect(launches).toBe(2)
    closed.resolve()
    const restored = await second
    await Promise.all([run, stop])
    expect(log).toEqual(["open one", "interrupt", "open two", "interrupted", "closed", "open one"])
    expect(restored.nativeSessionId).toBe(first.nativeSessionId)
    await driver.dispose(restored)
  } finally {
    stopping.resolve()
    closed.resolve()
    await driver.close()
  }
})
