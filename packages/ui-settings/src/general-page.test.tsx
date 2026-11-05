/** 通用设置页：版本号来自主进程，文案里显示真实版本而不是写死的数字。 */
// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it } from "vitest"
import { GeneralPage } from "./general-page"

afterEach(cleanup)

function withBridge(version: () => Promise<string>, children = <GeneralPage />) {
  ;(globalThis as { pigcodeNative?: unknown }).pigcodeNative = { appVersion: version }
  return render(<LocaleProvider locale="zh-CN">{children}</LocaleProvider>)
}

describe("GeneralPage", () => {
  it("shows the version the app reports", async () => {
    withBridge(async () => "1.2.3")
    expect(await screen.findByText("当前版本 1.2.3")).toBeTruthy()
    delete (globalThis as { pigcodeNative?: unknown }).pigcodeNative
  })

  it("shows nothing rather than a placeholder when the version can't be read", async () => {
    withBridge(() => Promise.reject(new Error("no bridge")))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(screen.queryByText(/当前版本/)).toBeNull()
    delete (globalThis as { pigcodeNative?: unknown }).pigcodeNative
  })
})
