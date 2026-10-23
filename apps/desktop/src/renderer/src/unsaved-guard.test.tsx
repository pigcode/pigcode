/** 验证有未保存的文件修改时页面阻止卸载，并把确认框文案交给主进程。 */
// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { setDraft } from "./file-drafts"
import { UnsavedGuard } from "./unsaved-guard"

afterEach(() => {
  cleanup()
  setDraft("thread-1", "src/a.ts", null)
  delete window.pigcodeNative
})

function unload(): Event {
  const event = new Event("beforeunload", { cancelable: true })
  window.dispatchEvent(event)
  return event
}

describe("UnsavedGuard", () => {
  it("blocks unloading only while a file has unsaved changes", () => {
    const setUnsavedLabels = vi.fn(async () => undefined)
    window.pigcodeNative = { setUnsavedLabels } as unknown as NonNullable<Window["pigcodeNative"]>
    render(
      <LocaleProvider locale="zh-CN">
        <UnsavedGuard />
      </LocaleProvider>,
    )
    expect(setUnsavedLabels).toHaveBeenCalledWith({
      message: "放弃未保存的修改？",
      detail: "有文件还没保存，关闭或刷新窗口后这些修改会丢失。",
      discard: "放弃修改",
      cancel: "继续编辑",
    })
    expect(unload().defaultPrevented).toBe(false)

    act(() => setDraft("thread-1", "src/a.ts", "changed"))
    expect(unload().defaultPrevented).toBe(true)

    act(() => setDraft("thread-1", "src/a.ts", null))
    expect(unload().defaultPrevented).toBe(false)
  })
})
