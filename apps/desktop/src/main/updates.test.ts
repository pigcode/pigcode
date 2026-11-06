/** 验证发现新版本以后做什么：能装的装好再问重启，不能装的只打开下载页。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const showMessageBox = vi.fn()
const openExternal = vi.fn()

vi.mock("electron", () => ({
  app: { getLocale: () => "zh-CN", getVersion: () => "0.1.0", isPackaged: true },
  dialog: { showMessageBox },
  shell: { openExternal },
}))

const { createUpdates } = await import("./updates")
type Options = Omit<Partial<import("./updates").UpdateOptions>, "getWindow" | "autoCheck">

const release = {
  version: "0.2.0",
  url: "https://github.com/pigcode/pigcode/releases/tag/v0.2.0",
}

beforeEach(() => {
  vi.useFakeTimers()
  showMessageBox.mockReset()
  openExternal.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

/** 启动后台检查并跑到第一次检查结束。 */
async function findUpdate(options: Options): Promise<ReturnType<typeof createUpdates>> {
  const updates = createUpdates({
    getWindow: () => undefined,
    autoCheck: () => true,
    allowPrerelease: () => false,
    fetchRelease: async () => release,
    ...options,
  })
  updates.start()
  await vi.advanceTimersByTimeAsync(5000)
  return updates
}

describe("update prompt", () => {
  it("downloads and offers a restart when the package can install updates", async () => {
    const download = vi.fn(async () => true)
    const requestRestart = vi.fn()
    showMessageBox.mockResolvedValue({ response: 0 })
    await findUpdate({ mode: "install", isPackaged: true, download, requestRestart })

    expect(download).toHaveBeenCalledTimes(1)
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "新版本 0.2.0 已下载",
        buttons: ["重启并更新", "稍后"],
      }),
    )
    // 重启走正常退出流程（before-quit 里的任务确认）。
    expect(requestRestart).toHaveBeenCalledTimes(1)
  })

  it("leaves the install for later when the user picks it", async () => {
    const requestRestart = vi.fn()
    showMessageBox.mockResolvedValue({ response: 1 })
    await findUpdate({
      mode: "install",
      isPackaged: true,
      download: async () => true,
      requestRestart,
    })
    expect(requestRestart).not.toHaveBeenCalled()
  })

  it("falls back to the download page when the download fails", async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    await findUpdate({ mode: "install", isPackaged: true, download: async () => false })

    // 下载失败时只弹这一次：退回下载页。
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    const [first] = showMessageBox.mock.calls[0] as [{ message: string }]
    expect(first.message).toBe("有新版本 0.2.0")
    expect(openExternal).toHaveBeenCalledWith(release.url)
  })

  it("installs and restarts the downloaded update when asked at quit", async () => {
    const install = vi.fn()
    showMessageBox.mockResolvedValue({ response: 1 })
    const updates = await findUpdate({
      mode: "install",
      isPackaged: true,
      download: async () => true,
      install,
    })
    // 什么都没下载时不能接管退出。
    const cold = createUpdates({
      getWindow: () => undefined,
      autoCheck: () => false,
      mode: "install",
      isPackaged: true,
      install,
    })
    expect(cold.installIfReady()).toBe(false)
    // 下载过以后，退出交给 electron-updater（它会装好并重新打开应用）。
    expect(updates.installIfReady()).toBe(true)
    expect(install).toHaveBeenCalledTimes(1)
  })

  it("only opens the download page on macOS and deb packages", async () => {
    const download = vi.fn(async () => true)
    showMessageBox.mockResolvedValue({ response: 0 })
    await findUpdate({ mode: "notify", isPackaged: true, download })

    expect(download).not.toHaveBeenCalled()
    expect(showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ message: "有新版本 0.2.0", buttons: ["打开下载页", "稍后"] }),
    )
    expect(openExternal).toHaveBeenCalledWith(release.url)
  })
})
