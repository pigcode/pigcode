/** 应用更新通过状态与显式动作接入统一入口。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const openExternal = vi.fn()
const { autoUpdater } = vi.hoisted(() => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    checkForUpdates: vi.fn(async () => ({})),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))
vi.mock("electron", () => ({
  app: { getVersion: () => "0.1.0", isPackaged: true, quit: vi.fn() },
  shell: { openExternal },
}))
vi.mock("electron-updater", () => ({ autoUpdater }))
const { createUpdates } = await import("./updates")
type Options = Partial<import("./updates").UpdateOptions>
const release = { version: "0.2.0", url: "https://github.com/pigcode/pigcode/releases/tag/v0.2.0" }

function setup(options: Options = {}) {
  return createUpdates({
    autoCheck: () => true,
    allowPrerelease: () => false,
    fetchRelease: async () => release,
    ...options,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = false
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("unified app updates", () => {
  it("publishes discovery without downloading or opening another window", async () => {
    const download = vi.fn(async () => true)
    const onState = vi.fn()
    const updates = setup({ mode: "install", isPackaged: true, download, onState })
    updates.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(updates.getState()).toMatchObject({
      phase: "available",
      version: "0.2.0",
      action: "download",
    })
    expect(download).not.toHaveBeenCalled()
    expect(openExternal).not.toHaveBeenCalled()
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ phase: "available" }))
  })

  it("updates the same state from a manual check", async () => {
    const updates = setup({ mode: "notify" })
    expect(await updates.checkNow()).toEqual({ status: "update-available", ...release })
    expect(updates.getState()).toMatchObject({ phase: "available", action: "open-release" })
    await updates.perform()
    expect(openExternal).toHaveBeenCalledWith(release.url)
  })

  it("downloads once, reports progress, and waits for the restart action", async () => {
    let finish!: (value: boolean) => void
    const download = vi.fn((progress: (percent: number) => void) => {
      progress(45)
      return new Promise<boolean>((resolve) => {
        finish = resolve
      })
    })
    const requestRestart = vi.fn()
    const install = vi.fn()
    const updates = setup({ mode: "install", isPackaged: true, download, requestRestart, install })
    await updates.checkNow()
    const first = updates.perform()
    expect(updates.perform()).toBe(first)
    expect(updates.getState()).toMatchObject({ phase: "downloading", progress: 45 })
    expect(updates.installIfReady()).toBe(false)
    finish(true)
    await first
    expect(download).toHaveBeenCalledTimes(1)
    expect(updates.getState()).toMatchObject({ phase: "ready", action: "restart", progress: 100 })
    expect(requestRestart).not.toHaveBeenCalled()
    await updates.perform()
    expect(requestRestart).toHaveBeenCalledTimes(1)
    expect(updates.installIfReady()).toBe(true)
    expect(install).toHaveBeenCalledTimes(1)
  })

  it("retains the selected release while a download is running", async () => {
    let finish!: (value: boolean) => void
    const fetchRelease = vi.fn(async () => release)
    const updates = setup({
      mode: "install",
      isPackaged: true,
      fetchRelease,
      download: () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        }),
    })
    await updates.checkNow()
    const downloading = updates.perform()
    await updates.checkNow()
    expect(fetchRelease).toHaveBeenCalledTimes(1)
    expect(updates.getState().phase).toBe("downloading")
    finish(true)
    await downloading
  })

  it("retries a failed download", async () => {
    const download = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const updates = setup({ mode: "install", isPackaged: true, download })
    await updates.checkNow()
    await updates.perform()
    expect(updates.getState()).toMatchObject({
      phase: "failed",
      error: "download",
      action: "download",
    })
    await updates.perform()
    expect(updates.getState()).toMatchObject({ phase: "ready", error: null })
  })

  it("opens the macOS installer only on the explicit open action", async () => {
    const openPath = vi.fn(async () => "")
    const downloadPackage = vi.fn(async () => ({ path: "/tmp/Pigcode.dmg" }))
    const updates = setup({ mode: "replace", isPackaged: true, openPath, downloadPackage })
    await updates.checkNow()
    await updates.perform()
    expect(updates.getState()).toMatchObject({ phase: "ready", action: "open-package" })
    expect(openPath).not.toHaveBeenCalled()
    expect(updates.installIfReady()).toBe(false)
    await updates.perform()
    expect(openPath).toHaveBeenCalledWith("/tmp/Pigcode.dmg")
  })

  it("reports installer opening failures and allows another attempt", async () => {
    const openPath = vi.fn().mockResolvedValueOnce("failed").mockResolvedValue("")
    const updates = setup({
      mode: "replace",
      isPackaged: true,
      openPath,
      downloadPackage: async () => ({ path: "/tmp/Pigcode.dmg" }),
    })
    await updates.checkNow()
    await updates.perform()
    await updates.perform()
    expect(updates.getState()).toMatchObject({ phase: "failed", error: "open" })
    await updates.perform()
    expect(openPath).toHaveBeenCalledTimes(2)
    expect(updates.getState().error).toBeNull()
    expect(updates.getState().phase).toBe("ready")
  })

  it("uses the release page for development builds", async () => {
    const downloadPackage = vi.fn()
    const updates = setup({ mode: "replace", isPackaged: false, downloadPackage })
    await updates.checkNow()
    expect(updates.getState().action).toBe("open-release")
    await updates.perform()
    expect(openExternal).toHaveBeenCalledWith(release.url)
    expect(downloadPackage).not.toHaveBeenCalled()
  })

  it("uses the release page when no macOS package matches the architecture", async () => {
    const updates = setup({ mode: "replace", isPackaged: true, arch: "arm64" })
    await updates.checkNow()
    expect(updates.getState().action).toBe("open-release")
    await updates.perform()
    expect(openExternal).toHaveBeenCalledWith(release.url)
  })

  it.each([true, false])("passes prerelease preference %s to the installer", async (allow) => {
    vi.useRealTimers()
    const updates = setup({ mode: "install", isPackaged: true, allowPrerelease: () => allow })
    await updates.checkNow()
    await updates.perform()
    expect(autoUpdater.allowPrerelease).toBe(allow)
    expect(autoUpdater.autoDownload).toBe(false)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true)
    expect(autoUpdater.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(autoUpdater.removeListener).toHaveBeenCalledWith(
      "download-progress",
      expect.any(Function),
    )
  })

  it("clears an old result and reports a failed check", async () => {
    const fetchRelease = vi
      .fn()
      .mockResolvedValueOnce(release)
      .mockResolvedValueOnce({ ...release, version: "0.1.0" })
      .mockResolvedValue(null)
    const updates = setup({ fetchRelease })
    await updates.checkNow()
    await updates.checkNow()
    expect(updates.getState()).toMatchObject({ phase: "idle", version: null, action: null })
    await updates.checkNow()
    expect(updates.getState()).toMatchObject({ phase: "failed", error: "check", version: null })
  })
})
