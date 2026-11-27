// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Connection } from "@pigcode/client-runtime"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { CoreDeps } from "./chat-container"
import { PairingSettings } from "./pairing-settings"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function makeDeps(call: Connection["call"]): CoreDeps {
  return {
    connection: { call } as unknown as Connection,
  } as unknown as CoreDeps
}

describe("PairingSettings mobile preview toggle", () => {
  it("loads default enabled state, disables preview, and re-enables preview via Host RPC", async () => {
    let previewEnabled = true
    const call = vi.fn<Connection["call"]>().mockImplementation(async (method, params) => {
      if (method === "mobile.pairing") {
        return { status: "idle", attempt: null, devices: [] }
      }
      if (method === "mobile.preview.getSettings") {
        return { enabled: previewEnabled, desktopUrls: ["http://localhost:5173/"] }
      }
      if (method === "mobile.preview.setEnabled") {
        previewEnabled = Boolean((params as { enabled?: boolean }).enabled)
        return { enabled: previewEnabled, desktopUrls: ["http://localhost:5173/"] }
      }
      return {}
    })

    render(
      <LocaleProvider locale="zh-CN">
        <PairingSettings deps={makeDeps(call)} relayReady />
      </LocaleProvider>,
    )

    expect(
      screen.getByText("允许已配对的手机通过端到端加密通道预览这台主机上的 localhost 开发页面。"),
    ).toBeTruthy()

    const toggle = screen.getByRole("switch", { name: "允许已配对手机预览本机服务" })
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith("mobile.preview.getSettings", {})
      expect(toggle.getAttribute("aria-checked")).toBe("true")
      expect(toggle.hasAttribute("disabled")).toBe(false)
    })

    // 切换关闭
    await userEvent.click(toggle)
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith("mobile.preview.setEnabled", { enabled: false })
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    })

    // 重新开启
    await userEvent.click(toggle)
    await waitFor(() => {
      expect(call).toHaveBeenCalledWith("mobile.preview.setEnabled", { enabled: true })
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    })
  })

  it("keeps the previous state and shows an alert when updating preview settings fails", async () => {
    const call = vi.fn<Connection["call"]>().mockImplementation(async (method) => {
      if (method === "mobile.pairing") {
        return { status: "idle", attempt: null, devices: [] }
      }
      if (method === "mobile.preview.getSettings") {
        return { enabled: true, desktopUrls: [] }
      }
      if (method === "mobile.preview.setEnabled") {
        throw new Error("host offline")
      }
      return {}
    })

    render(
      <LocaleProvider locale="zh-CN">
        <PairingSettings deps={makeDeps(call)} relayReady />
      </LocaleProvider>,
    )

    const toggle = screen.getByRole("switch", { name: "允许已配对手机预览本机服务" })
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false))

    await userEvent.click(toggle)
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe(
        "无法读取或更新本机预览设置，请检查本机 Host 连接。",
      )
    })
    expect(toggle.getAttribute("aria-checked")).toBe("true")
  })
})
