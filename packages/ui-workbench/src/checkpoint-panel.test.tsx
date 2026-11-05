/** 恢复前要让用户知道：只有文件会回去，对话不会。 */
// @vitest-environment jsdom
import { cleanup, render as renderUi, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CheckpointPanel, type CheckpointItem } from "./checkpoint-panel"

const CHECKPOINT: CheckpointItem = {
  id: "cp-1",
  runId: null,
  phase: "manual",
  label: null,
  createdAt: "2026-11-05T00:00:00.000Z",
}

function setup(locale: "zh-CN" | "en-US", onRestore = vi.fn()) {
  renderUi(
    <LocaleProvider locale={locale}>
      <CheckpointPanel checkpoints={[CHECKPOINT]} onRestore={onRestore} />
    </LocaleProvider>,
  )
  return onRestore
}

afterEach(cleanup)

describe("CheckpointPanel", () => {
  it("says the conversation is not rolled back before anything is restored", async () => {
    const onRestore = setup("zh-CN")
    await userEvent.click(screen.getByRole("button", { name: "恢复" }))
    expect(screen.getByText(/对话不会回滚/)).toBeTruthy()
    expect(onRestore).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole("button", { name: "确认恢复" }))
    expect(onRestore).toHaveBeenCalledWith("cp-1")
  })

  it("says the same in English", async () => {
    setup("en-US")
    await userEvent.click(screen.getByRole("button", { name: "Restore" }))
    expect(screen.getByText(/conversation is not rolled back/)).toBeTruthy()
  })
})
