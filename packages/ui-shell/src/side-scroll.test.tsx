/** 验证侧栏列表区的渐隐：滚动后上沿渐隐，下面还有内容时下沿渐隐，没有溢出时两头都不渐隐。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { SideScroll } from "./side-scroll"

afterEach(cleanup)

describe("SideScroll", () => {
  it("fades the top edge once scrolled and the bottom edge while more is below", () => {
    const { container } = render(
      <SideScroll>
        <p>rows</p>
      </SideScroll>,
    )
    const scroller = container.querySelector(".side-scroll") as HTMLElement
    const fades = () => [
      scroller.hasAttribute("data-fade-top"),
      scroller.hasAttribute("data-fade-bottom"),
    ]
    expect(scroller.querySelector(".side-scroll-body")?.textContent).toBe("rows")
    expect(fades()).toEqual([false, false])

    const metrics = { scrollTop: 0, clientHeight: 300, scrollHeight: 900 }
    for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) {
      Object.defineProperty(scroller, key, { configurable: true, get: () => metrics[key] })
    }
    fireEvent.scroll(scroller)
    expect(fades()).toEqual([false, true])
    metrics.scrollTop = 200
    fireEvent.scroll(scroller)
    expect(fades()).toEqual([true, true])
    metrics.scrollTop = 600
    fireEvent.scroll(scroller)
    expect(fades()).toEqual([true, false])
    metrics.scrollTop = 0
    fireEvent.scroll(scroller)
    expect(fades()).toEqual([false, true])
  })
})
