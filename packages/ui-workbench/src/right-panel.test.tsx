/** 验证右栏 tab 切换。 */
// @vitest-environment jsdom
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { RightPanel } from "./right-panel"

describe("RightPanel", () => {
  it("switches tabs", async () => {
    const onTab = vi.fn()
    render(
      <RightPanel
        threadId="t1"
        tabs={{ files: <div>files</div>, diff: <div>diff</div>, terminal: <div>term</div> }}
        active="files"
        onTab={onTab}
      />,
    )
    expect(screen.getByText("files")).toBeTruthy()
    await userEvent.click(screen.getByRole("tab", { name: "Diff" }))
    expect(onTab).toHaveBeenCalledWith("diff")
  })
})
