/** 验证退出确认框的文案：只写真正有的工作，数量和语言都对。 */
import { describe, expect, it } from "vitest"
import { quitDetail, quitLabels } from "./quit"

describe("quit confirmation", () => {
  it("lists only the work that exists", () => {
    const labels = quitLabels("zh-CN")
    expect(quitDetail(labels, { runs: 2, approvals: 0, schedules: 0 })).toEqual([
      "2 个任务还在跑或在排队，退出会让它们停下",
    ])
    expect(quitDetail(labels, { runs: 0, approvals: 1, schedules: 3 })).toEqual([
      "1 个请求在等你确认",
      "3 个定时任务开着，退出后到点也不会跑",
    ])
  })

  it("follows the system language", () => {
    expect(quitDetail(quitLabels("en-US"), { runs: 1, approvals: 0, schedules: 0 })[0]).toContain(
      "1 task(s)",
    )
    expect(quitLabels("zh-TW").title).toBe("还有工作在运行")
  })
})
