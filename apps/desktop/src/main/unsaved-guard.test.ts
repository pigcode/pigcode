/** 验证未保存修改确认框：文案校验与按钮选择。 */
import { describe, expect, it, vi } from "vitest"
import type { MessageBoxSyncOptions } from "electron"
import { DEFAULT_UNSAVED_LABELS, confirmDiscard, readUnsavedGuardLabels } from "./unsaved-guard"

const labels = {
  message: "放弃未保存的修改？",
  detail: "有文件还没保存，关闭或刷新窗口后这些修改会丢失。",
  discard: "放弃修改",
  cancel: "继续编辑",
}

describe("readUnsavedGuardLabels", () => {
  it("accepts four short texts and rejects anything else as a whole", () => {
    expect(readUnsavedGuardLabels(labels)).toEqual(labels)
    expect(readUnsavedGuardLabels({ ...labels, cancel: "" })).toBeNull()
    expect(readUnsavedGuardLabels({ ...labels, detail: "x".repeat(201) })).toBeNull()
    expect(readUnsavedGuardLabels({ message: "a", detail: "b", discard: "c" })).toBeNull()
    expect(readUnsavedGuardLabels("discard")).toBeNull()
  })
})

describe("confirmDiscard", () => {
  it("only continues when the discard button is chosen; Keep editing is the default", () => {
    const show = vi.fn<(options: MessageBoxSyncOptions) => number>(() => 1)
    expect(confirmDiscard(show, labels)).toBe(false)
    expect(show.mock.calls[0]?.[0]).toMatchObject({
      buttons: ["放弃修改", "继续编辑"],
      defaultId: 1,
      cancelId: 1,
      message: labels.message,
      detail: labels.detail,
    })
    expect(confirmDiscard(() => 0, DEFAULT_UNSAVED_LABELS)).toBe(true)
  })
})
