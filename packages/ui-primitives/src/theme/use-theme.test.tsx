// @vitest-environment jsdom
/** 验证 useTheme 读根元素的 data-theme，并在主题切换后通知组件。 */
import { act, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { useTheme } from "./use-theme"

afterEach(() => {
  delete document.documentElement.dataset.theme
})

/** 把 hook 的值画出来。 */
function Probe() {
  return <span data-testid="theme">{useTheme()}</span>
}

describe("useTheme", () => {
  it("reads the root's data-theme and follows changes", async () => {
    render(<Probe />)
    // 没有 data-theme 时按浅色。
    expect(screen.getByTestId("theme").textContent).toBe("light")

    act(() => {
      document.documentElement.dataset.theme = "dark"
    })
    await waitFor(() => expect(screen.getByTestId("theme").textContent).toBe("dark"))

    act(() => {
      document.documentElement.dataset.theme = "light"
    })
    await waitFor(() => expect(screen.getByTestId("theme").textContent).toBe("light"))
  })
})
