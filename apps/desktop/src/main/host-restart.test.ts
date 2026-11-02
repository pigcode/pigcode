/** 验证 Host 的重启策略：活得久的立即重启，快速失败指数退避，连续失败到上限后停下。 */
import { describe, expect, it } from "vitest"
import { DEFAULT_RESTART_POLICY, decideRestart, readHostFatal } from "./host-restart"
import { hostFailureDetail, hostFailureText } from "./locale/host-failure"

const policy = { quickMs: 10_000, maxQuickFailures: 4, baseDelayMs: 500, maxDelayMs: 1_500 }

describe("host restart policy", () => {
  it("restarts a host that ran for a while right away and resets the count", () => {
    expect(decideRestart(3, 60_000, policy)).toEqual({
      action: "restart",
      delayMs: 0,
      quickFailures: 0,
    })
  })

  it("backs off on quick failures, caps the delay and gives up after the limit", () => {
    let failures = 0
    const delays: number[] = []
    for (;;) {
      const decision = decideRestart(failures, 200, policy)
      failures = decision.quickFailures
      if (decision.action === "give-up") break
      delays.push(decision.delayMs)
    }
    expect(delays).toEqual([500, 1_000, 1_500])
    expect(failures).toBe(4)
  })

  it("forgets earlier quick failures once a host stays up", () => {
    const quick = decideRestart(0, 100, policy)
    const healthy = decideRestart(quick.quickFailures, 20_000, policy)
    expect(decideRestart(healthy.quickFailures, 100, policy)).toEqual({
      action: "restart",
      delayMs: 500,
      quickFailures: 1,
    })
  })

  it("uses a bounded default policy", () => {
    expect(DEFAULT_RESTART_POLICY.maxQuickFailures).toBeGreaterThan(1)
    expect(DEFAULT_RESTART_POLICY.maxDelayMs).toBeLessThanOrEqual(10_000)
  })

  it("reads the fatal reason the host sends before exiting", () => {
    expect(readHostFatal({ type: "fatal", message: "database schema v8 is newer" })).toBe(
      "database schema v8 is newer",
    )
    expect(readHostFatal({ type: "ports" })).toBeNull()
    expect(readHostFatal("fatal")).toBeNull()
  })

  it("picks the dialog language from the locale and appends the reason", () => {
    expect(hostFailureText("zh-CN").message).not.toBe(hostFailureText("en-US").message)
    expect(hostFailureText("zh-TW")).toBe(hostFailureText("zh-CN"))
    expect(hostFailureText("fr")).toBe(hostFailureText("en-US"))
    const detail = hostFailureDetail(hostFailureText("en-US"), 5, "disk full")
    expect(detail).toContain("5 times")
    expect(detail).toContain("Reason: disk full")
    expect(hostFailureDetail(hostFailureText("en-US"), 5, null)).not.toContain("Reason")
  })
})
