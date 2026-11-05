/** 验证自动检查的节拍：提示一次、失败不提示、关掉后不查。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createUpdateScheduler, type UpdateSchedulerDeps } from "./update-scheduler"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

function setup(overrides: Partial<UpdateSchedulerDeps> = {}) {
  const prompted: string[] = []
  const logged: string[] = []
  const fetchRelease = vi.fn(async () => ({
    version: "0.2.0",
    url: "https://github.com/pigcode/frontend/releases/tag/v0.2.0",
  }))
  const deps: UpdateSchedulerDeps = {
    apiUrl: () => "http://localhost/latest",
    enabled: () => true,
    autoCheck: () => true,
    currentVersion: () => "0.1.0",
    prompt: async (release) => {
      prompted.push(release.version)
    },
    log: (message) => logged.push(message),
    fetchRelease,
    ...overrides,
  }
  return { scheduler: createUpdateScheduler(deps), prompted, logged, fetchRelease }
}

describe("update scheduler", () => {
  it("checks once at startup and then every six hours", async () => {
    const { scheduler, fetchRelease } = setup()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchRelease).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(fetchRelease).toHaveBeenCalledTimes(2)
    scheduler.stop()
  })

  it("asks about the same version only once", async () => {
    const { scheduler, prompted } = setup()
    scheduler.start()
    await vi.advanceTimersByTimeAsync(5000)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(prompted).toEqual(["0.2.0"])
    scheduler.stop()
  })

  it("says nothing when the check fails", async () => {
    const { scheduler, prompted, logged } = setup({ fetchRelease: async () => null })
    scheduler.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(prompted).toEqual([])
    expect(logged).toEqual(["update check failed"])
    scheduler.stop()
  })

  it("does nothing when automatic checks are off or disabled", async () => {
    const off = setup({ autoCheck: () => false })
    off.scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(off.fetchRelease).not.toHaveBeenCalled()
    const disabled = setup({ enabled: () => false })
    disabled.scheduler.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(disabled.fetchRelease).not.toHaveBeenCalled()
  })

  it("reports the result of a manual check", async () => {
    const { scheduler } = setup()
    await expect(scheduler.checkNow()).resolves.toEqual({
      status: "update-available",
      version: "0.2.0",
      url: "https://github.com/pigcode/frontend/releases/tag/v0.2.0",
    })
    const current = setup({ currentVersion: () => "0.2.0" })
    await expect(current.scheduler.checkNow()).resolves.toEqual({ status: "up-to-date" })
  })
})
