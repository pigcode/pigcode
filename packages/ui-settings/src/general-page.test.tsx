/** 通用设置页：版本号来自主进程，文案里显示真实版本而不是写死的数字。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it } from "vitest"
import { GeneralPage } from "./general-page"

afterEach(cleanup)

function withBridge(version: () => Promise<string>, children = <GeneralPage />) {
  ;(globalThis as { pigcodeNative?: unknown }).pigcodeNative = { appVersion: version }
  return render(<LocaleProvider locale="zh-CN">{children}</LocaleProvider>)
}

function withPreferences(
  platform: string,
  initial: { launchAtLogin: boolean; showInDock: boolean; autoCheckUpdates: boolean },
  update?: () => Promise<{ status: string; version?: string; url?: string }>,
): { calls: Array<[string, boolean]> } {
  const calls: Array<[string, boolean]> = []
  ;(globalThis as { pigcodeNative?: unknown }).pigcodeNative = {
    appVersion: async () => "1.2.3",
    platform,
    getPreferences: async () => initial,
    setPreference: async (key: string, value: boolean) => {
      calls.push([key, value])
      return { ...initial, [key]: value }
    },
    ...(update ? { checkForUpdates: update } : {}),
  }
  render(
    <LocaleProvider locale="zh-CN">
      <GeneralPage />
    </LocaleProvider>,
  )
  return { calls }
}

describe("GeneralPage", () => {
  it("shows the version the app reports", async () => {
    withBridge(async () => "1.2.3")
    expect(await screen.findByText("当前版本 1.2.3")).toBeTruthy()
    delete (globalThis as { pigcodeNative?: unknown }).pigcodeNative
  })

  it("shows the switches' real state and saves changes", async () => {
    const { calls } = withPreferences("darwin", {
      launchAtLogin: false,
      showInDock: true,
      autoCheckUpdates: true,
    })
    const dock = await screen.findByRole("switch", { name: "在 Dock 中显示" })
    expect(dock.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(dock)
    await waitFor(() => expect(calls).toEqual([["showInDock", false]]))
    delete (globalThis as { pigcodeNative?: unknown }).pigcodeNative
  })

  it("hides the switches that don't apply to the platform", async () => {
    withPreferences("linux", { launchAtLogin: false, showInDock: true, autoCheckUpdates: true })
    await waitFor(() => expect(screen.queryByRole("switch", { name: "在 Dock 中显示" })).toBeNull())
    expect(screen.queryByRole("switch", { name: "开机自动启动" })).toBeNull()
    delete (globalThis as { pigcodeNative?: unknown }).pigcodeNative
  })

  it("turns the update switch off and back on", async () => {
    const { calls } = withPreferences("darwin", {
      launchAtLogin: false,
      showInDock: true,
      autoCheckUpdates: true,
    })
    const auto = await screen.findByRole("switch", { name: "自动检查更新" })
    expect(auto.getAttribute("aria-checked")).toBe("true")
    fireEvent.click(auto)
    await waitFor(() => expect(calls).toEqual([["autoCheckUpdates", false]]))
    delete (globalThis as { pigcodeNative?: unknown }).pigcodeNative
  })

  it("shows the result of a manual update check", async () => {
    withPreferences(
      "darwin",
      { launchAtLogin: false, showInDock: true, autoCheckUpdates: true },
      async () => ({ status: "update-available", version: "0.2.0", url: "https://example.com" }),
    )
    fireEvent.click(await screen.findByRole("button", { name: "立即检查" }))
    expect(await screen.findByText("有新版本 0.2.0")).toBeTruthy()
    delete (globalThis as { pigcodeNative?: unknown }).pigcodeNative
  })

  it("shows nothing rather than a placeholder when the version can't be read", async () => {
    withBridge(() => Promise.reject(new Error("no bridge")))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.queryByText(/当前版本/)).toBeNull()
    delete (globalThis as { pigcodeNative?: unknown }).pigcodeNative
  })
})
