/** 验证退出检查的端口交互：应答要认 id，坏数据不计，没应答时按 null 返回。 */
import { describe, expect, it, vi } from "vitest"
import { askQuitState, hasPendingWork, type QuitStatePort } from "./quit-check"

/** 可控的假控制端口：记下发出的消息，需要时手动回一条。 */
function fakePort(): QuitStatePort & { sent: unknown[]; reply: (data: unknown) => void } {
  const sent: unknown[] = []
  let listener: ((event: { data?: unknown }) => void) | undefined
  return {
    sent,
    on: (_event, next) => {
      listener = next
    },
    off: () => {
      listener = undefined
    },
    postMessage: (message) => {
      sent.push(message)
    },
    reply: (data) => listener?.({ data }),
  }
}

describe("quit state over the control port", () => {
  it("reads the counts and drops bad values", async () => {
    const port = fakePort()
    const pending = askQuitState(port)
    port.reply({
      type: "app.quit-state",
      id: (port.sent[0] as { id: number }).id,
      state: { runs: 2, approvals: -1, schedules: "3" },
    })
    await expect(pending).resolves.toEqual({ runs: 2, approvals: 0, schedules: 0 })
  })

  it("ignores replies to another request", async () => {
    const port = fakePort()
    const pending = askQuitState(port, 50)
    port.reply({ type: "app.quit-state", id: 1, state: { runs: 5 } })
    port.reply({ type: "browser.request", id: (port.sent[0] as { id: number }).id })
    await expect(pending).resolves.toBeNull()
  })

  it("gives up when the Host doesn't answer", async () => {
    vi.useFakeTimers()
    try {
      const port = fakePort()
      const pending = askQuitState(port, 1000)
      await vi.advanceTimersByTimeAsync(1000)
      await expect(pending).resolves.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("knows when there is nothing to warn about", () => {
    expect(hasPendingWork({ runs: 0, approvals: 0, schedules: 0 })).toBe(false)
    expect(hasPendingWork({ runs: 0, approvals: 0, schedules: 1 })).toBe(true)
    expect(hasPendingWork({ runs: 1, approvals: 0, schedules: 0 })).toBe(true)
  })
})
