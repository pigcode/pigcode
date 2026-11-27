import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  BUILT_RENDERER_URL,
  acquireInstanceLock,
  hostConflictDialogText,
  rendererUrl,
  restartedByElectronVite,
  waitForHostLockFree,
  watchHostBuild,
  watchesHostBuild,
} from "./dev-mode"

describe("rendererUrl", () => {
  it("loads the Vite dev server while developing", () => {
    expect(rendererUrl({ ELECTRON_RENDERER_URL: "http://localhost:5173" }, false)).toBe(
      "http://localhost:5173",
    )
  })

  it("loads the built page without a dev server", () => {
    expect(rendererUrl({}, false)).toBe(BUILT_RENDERER_URL)
  })

  it("ignores the dev server URL in a packaged app", () => {
    expect(rendererUrl({ ELECTRON_RENDERER_URL: "http://localhost:5173" }, true)).toBe(
      BUILT_RENDERER_URL,
    )
  })
})

describe("watchesHostBuild", () => {
  it("follows the flag scripts/dev.ts sets", () => {
    expect(watchesHostBuild({ PIGCODE_DEV_HOST_WATCH: "1" }, false)).toBe(true)
    expect(watchesHostBuild({}, false)).toBe(false)
    expect(watchesHostBuild({ PIGCODE_DEV_HOST_WATCH: "1" }, true)).toBe(false)
  })
})

describe("watchHostBuild", () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it("fires when the marker is written, not for the file that was already there", async () => {
    dir = mkdtempSync(join(tmpdir(), "pigcode-dev-mode-"))
    const marker = join(dir, "build-id")
    writeFileSync(marker, "1")
    const onBuilt = vi.fn()
    const stop = watchHostBuild(marker, onBuilt)
    try {
      await new Promise((resolve) => setTimeout(resolve, 700))
      expect(onBuilt).not.toHaveBeenCalled()
      // 只改一次修改时间（往后挪，不依赖文件系统的时间精度）；先写内容再改时间是两次变化，
      // 轮询正好落在中间时会触发两次。
      const later = new Date(Date.now() + 5000)
      utimesSync(marker, later, later)
      await vi.waitFor(() => expect(onBuilt).toHaveBeenCalledTimes(1), { timeout: 3000 })
    } finally {
      stop()
    }
  })
})

describe("restartedByElectronVite", () => {
  it("is true only for an unpackaged app on the dev server", () => {
    expect(restartedByElectronVite({ ELECTRON_RENDERER_URL: "http://localhost:5173" }, false)).toBe(
      true,
    )
    expect(restartedByElectronVite({}, false)).toBe(false)
    expect(restartedByElectronVite({ ELECTRON_RENDERER_URL: "http://localhost:5173" }, true)).toBe(
      false,
    )
  })
})

describe("acquireInstanceLock", () => {
  it("returns at once when the lock is free", async () => {
    const request = vi.fn(() => true)
    await expect(acquireInstanceLock(request, 0)).resolves.toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("gives up at once without a wait, like a packaged app", async () => {
    const request = vi.fn(() => false)
    await expect(acquireInstanceLock(request, 0)).resolves.toBe(false)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("keeps trying while the previous instance is still quitting", async () => {
    let attempts = 0
    const request = () => (attempts += 1) >= 3
    await expect(acquireInstanceLock(request, 1000, 5)).resolves.toBe(true)
    expect(attempts).toBe(3)
  })

  it("gives up when the wait runs out", async () => {
    await expect(acquireInstanceLock(() => false, 30, 5)).resolves.toBe(false)
  })
})

describe("waitForHostLockFree", () => {
  it("returns null immediately when no live host owns the profile", async () => {
    const probe = vi.fn(async () => null)
    await expect(waitForHostLockFree(probe, 0)).resolves.toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it("polls until the previous host releases host.lock", async () => {
    const owner = {
      pid: 12345,
      instanceId: "00000000-0000-4000-8000-000000000001",
      runtime: "desktop" as const,
      socketPath: "/tmp/host.sock",
      startedAt: 1000,
      version: "0.1.0",
    }
    let count = 0
    const probe = vi.fn(async () => (++count >= 3 ? null : owner))
    await expect(waitForHostLockFree(probe, 1000, 5)).resolves.toBeNull()
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it("returns the active owner when host.lock stays occupied past waitMs", async () => {
    const owner = {
      pid: 23456,
      instanceId: "00000000-0000-4000-8000-000000000002",
      runtime: "headless" as const,
      socketPath: "/tmp/host.sock",
      startedAt: 1000,
      version: "0.1.0",
    }
    const probe = vi.fn(async () => owner)
    await expect(waitForHostLockFree(probe, 25, 5)).resolves.toEqual(owner)
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe("hostConflictDialogText", () => {
  it("describes headless and desktop lock owners clearly in Chinese", () => {
    const headlessText = hostConflictDialogText(
      {
        pid: 4321,
        instanceId: "00000000-0000-4000-8000-000000000003",
        runtime: "headless",
        socketPath: "/tmp/host.sock",
        startedAt: 1000,
        version: "0.1.0",
      },
      "/tmp/profile-a",
    )
    expect(headlessText.detail).toContain("headless")
    expect(headlessText.detail).toContain("4321")
    expect(headlessText.detail).toContain("/tmp/profile-a")

    const desktopText = hostConflictDialogText(
      {
        pid: 8765,
        instanceId: "00000000-0000-4000-8000-000000000004",
        runtime: "desktop",
        socketPath: "/tmp/host.sock",
        startedAt: 1000,
        version: "0.1.0",
      },
      "/tmp/profile-b",
    )
    expect(desktopText.detail).toContain("8765")
    expect(desktopText.detail).toContain("/tmp/profile-b")
    expect(desktopText.detail).not.toContain("headless")

    const englishText = hostConflictDialogText(
      {
        pid: 4321,
        instanceId: "00000000-0000-4000-8000-000000000005",
        runtime: "headless",
        socketPath: "/tmp/host.sock",
        startedAt: 1000,
        version: "0.1.0",
      },
      "/tmp/profile-en",
      "en-US",
    )
    expect(englishText.detail).toContain("headless")
    expect(englishText.detail).toContain("4321")
    expect(englishText.detail).toContain("/tmp/profile-en")
  })
})
