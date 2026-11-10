import { describe, expect, it, vi } from "vitest"
import { MemoryTransport } from "./memory-transport"
import { PageTransport } from "./page-transport"

describe("PageTransport", () => {
  it("sends to the page that connected last and stops listening to the old one", async () => {
    const page = new PageTransport()
    const received = vi.fn()
    page.onMessage(received)

    const first = new MemoryTransport()
    page.attach(first.host)
    first.client.send("from first")
    expect(received).toHaveBeenLastCalledWith("from first")

    const second = new MemoryTransport()
    page.attach(second.host)
    page.send("after reload")
    await expect(second.client.next()).resolves.toBe("after reload")

    first.client.send("stale")
    expect(received).not.toHaveBeenCalledWith("stale")
    second.client.send("from second")
    expect(received).toHaveBeenLastCalledWith("from second")
  })

  it("drops messages while no page is connected", () => {
    const page = new PageTransport()
    expect(() => page.send("nobody")).not.toThrow()
  })
})
