/** 验证命令面板的过滤、键盘执行与分组。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { CommandPalette } from "./command-palette"

afterEach(cleanup)

/** 渲染一个打开的面板；回调由测试注入。 */
function renderPalette(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const onClose = vi.fn()
  const onNewThread = vi.fn()
  const onPlugins = vi.fn()
  render(
    <LocaleProvider locale="zh-CN">
      <CommandPalette
        open
        onClose={onClose}
        projects={[]}
        threads={[]}
        activeThreadId={null}
        onNewThread={onNewThread}
        onOpenThread={() => {}}
        onAddProject={() => {}}
        onSettings={() => {}}
        onPlugins={onPlugins}
        {...overrides}
      />
    </LocaleProvider>,
  )
  return { onClose, onNewThread, onPlugins }
}

describe("CommandPalette", () => {
  it("filters commands by label and runs the selected one", async () => {
    const user = userEvent.setup()
    const { onPlugins } = renderPalette()

    await user.type(screen.getByLabelText("搜索或执行命令…"), "插件")
    const item = screen.getByRole("option", { name: /插件/ })
    await user.click(item)

    expect(onPlugins).toHaveBeenCalledTimes(1)
  })

  it("runs the first command on Enter", async () => {
    const user = userEvent.setup()
    const { onNewThread } = renderPalette()

    await user.keyboard("{Enter}")

    expect(onNewThread).toHaveBeenCalledTimes(1)
  })

  it("closes on Escape", async () => {
    const user = userEvent.setup()
    const { onClose } = renderPalette()

    await user.keyboard("{Escape}")

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
