/** 验证远程主机设置页（共享本机置顶、默认主机策略、主机列表与添加弹窗）及作用域路由。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { HOST_LOCAL_ID, type HostOutboundPairingStatus, type HostSummary } from "@pigcode/contracts"
import { AppStore, Connection, HostPool } from "@pigcode/client-runtime"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClientPluginController } from "./client-plugins"
import { DaemonSettingsPage } from "./daemon-settings-page"
import { AddRemoteHostDialog, RemoteHostsSettingsPage } from "./remote-hosts-page"
import { SettingsHostScopeContext } from "./settings-host-scope"

vi.mock("@pigcode/ui-workbench", () => ({ FILE_SURFACE_KIND: "file" }))

const NAS_SUMMARY: HostSummary = {
  id: "nas-1",
  name: "Home Linux NAS",
  hostKey: "N".repeat(43),
  kind: "headless",
  badgeColor: "green",
  status: "connected",
  channel: "relay",
  latencyMs: 32,
  lanAddresses: [],
  relayAddress: "wss://relay.example/ws/v1/connect",
  lastConnectedAt: 2000,
  lastError: null,
}

function fakeConnection(calls: Record<string, (params: unknown) => unknown>) {
  const spy = vi.fn(async (method: string, params: unknown) => {
    const fn = calls[method]
    if (!fn) return {}
    return fn(params)
  })
  const conn = {
    call: spy,
    attach: vi.fn(),
    detach: vi.fn(),
    onScheduleRunChange: () => () => undefined,
    onPluginsChanged: () => () => undefined,
  } as unknown as Connection
  return { conn, spy }
}

const FAKE_PLUGINS = {
  reload: vi.fn().mockResolvedValue(undefined),
  errors: {
    subscribe: () => () => undefined,
    get: () => [],
  },
} as unknown as ClientPluginController

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, "pigcodeNative")
})

describe("Multi-host Settings Pages", () => {
  it("renders Share This Host at the top of RemoteHostsSettingsPage and handles pairing link generation & verify", async () => {
    const store = new AppStore()
    store.update({ status: "connected" })
    const desktopPairingState = {
      status: "waiting" as const,
      attempt: {
        id: "11111111-1111-4111-8111-111111111111",
        expiresAt: Date.now() + 60_000,
        link: "pigcode://pair?v=1&d=TESTLINK",
        lanAddresses: ["ws://127.0.0.1:39000/ws"],
        candidate: {
          confirmation: "22222222-2222-4222-8222-222222222222",
          code: "482910",
          name: "Work MacBook",
          platform: "macos" as const,
        },
      },
      clients: [
        {
          id: "c".repeat(64),
          name: "Partner Laptop",
          platform: "windows" as const,
          lastConnectedAt: 1_700_000_000_000,
          connected: true,
        },
      ],
    }

    const { conn, spy } = fakeConnection({
      "relay.settings": () => ({ address: "", tokenConfigured: false }),
      "desktop.pairing": () => ({
        status: "idle",
        attempt: null,
        clients: desktopPairingState.clients,
      }),
      "desktop.pairing.start": () => desktopPairingState,
      "desktop.pairing.confirm": () => ({
        status: "paired",
        attempt: null,
        clients: desktopPairingState.clients,
      }),
      "desktop.pairing.cancel": () => ({
        status: "idle",
        attempt: null,
        clients: desktopPairingState.clients,
      }),
    })

    const setDefault = vi.fn().mockResolvedValue({ defaultTargetHostId: "nas-1" })
    Object.defineProperty(window, "pigcodeNative", {
      configurable: true,
      value: { platform: "darwin", hosts: { setDefault } },
    })

    const pool = new HostPool({ localConnection: conn, localStore: store, localName: "My Mac" })
    pool.syncRemoteHosts([NAS_SUMMARY], { defaultTargetHostId: HOST_LOCAL_ID })

    render(
      <LocaleProvider locale="zh-CN">
        <SettingsHostScopeContext.Provider
          value={{
            hostPool: pool,
            targetHostId: HOST_LOCAL_ID,
            setTargetHostId: () => {},
            onOpenSettingsPage: () => {},
            onStartDraftOnHost: () => false,
          }}
        >
          <RemoteHostsSettingsPage deps={{ connection: conn, store, plugins: FAKE_PLUGINS }} />
        </SettingsHostScopeContext.Provider>
      </LocaleProvider>,
    )

    // Verify "共享当前本机" comes before "默认目标主机" and "已添加的远程主机".
    const headings = Array.from(document.querySelectorAll(".section-head h2")).map(
      (h) => h.textContent,
    )
    expect(headings[0]).toBe("共享当前本机")
    expect(headings).toContain("默认目标主机")
    expect(headings).toContain("已添加的远程主机")

    await userEvent.click(screen.getByRole("button", { name: "生成共享链接" }))
    expect(await screen.findByText("pigcode://pair?v=1&d=TESTLINK")).toBeTruthy()
    expect(screen.getByText("482910")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "核对一致，允许连接" }))
    expect(spy).toHaveBeenCalledWith("desktop.pairing.confirm", {
      id: "11111111-1111-4111-8111-111111111111",
      confirmation: "22222222-2222-4222-8222-222222222222",
    })
    expect(screen.getByText("Home Linux NAS")).toBeTruthy()
  })

  it("displays AddRemoteHostDialog verification digits and localized error states", async () => {
    const startPairing = vi.fn().mockResolvedValue({ state: "connecting" })
    const cancelPairing = vi.fn().mockResolvedValue({ state: "idle" })
    Object.defineProperty(window, "pigcodeNative", {
      configurable: true,
      value: { platform: "darwin", hosts: { startPairing, cancelPairing } },
    })

    const baseState: HostOutboundPairingStatus = {
      state: "idle",
      hostName: null,
      hostKey: null,
      verificationCode: null,
      hostId: null,
      errorCode: null,
    }

    const { rerender } = render(
      <LocaleProvider locale="zh-CN">
        <AddRemoteHostDialog open onOpenChange={() => {}} pairingState={baseState} />
      </LocaleProvider>,
    )

    await userEvent.type(
      screen.getByLabelText("桌面端共享链接（pigcode://pair?...）"),
      "pigcode://pair?v=1&d=abc",
    )
    fireEvent.click(screen.getByRole("button", { name: "连接并校验" }))
    expect(startPairing).toHaveBeenCalledWith({
      link: "pigcode://pair?v=1&d=abc",
      badgeColor: "green",
    })

    rerender(
      <LocaleProvider locale="zh-CN">
        <AddRemoteHostDialog
          open
          onOpenChange={() => {}}
          pairingState={{
            state: "verify",
            hostName: "Home NAS",
            hostKey: "N".repeat(43),
            verificationCode: "739104",
            hostId: null,
            errorCode: null,
          }}
        />
      </LocaleProvider>,
    )
    expect(screen.getByText("739104")).toBeTruthy()

    rerender(
      <LocaleProvider locale="zh-CN">
        <AddRemoteHostDialog
          open
          onOpenChange={() => {}}
          pairingState={{ ...baseState, state: "failed", errorCode: "mobile-only" }}
        />
      </LocaleProvider>,
    )
    expect(screen.getByText(/手机 App 专用二维码/)).toBeTruthy()
  })

  it("routes DaemonSettingsPage host.setName & relay RPC to the selected remote host scope", async () => {
    const localStore = new AppStore()
    localStore.update({ status: "connected" })
    const { conn: localConn, spy: localSpy } = fakeConnection({})
    const pool = new HostPool({ localConnection: localConn, localStore, localName: "My Mac" })
    pool.syncRemoteHosts([NAS_SUMMARY], { defaultTargetHostId: HOST_LOCAL_ID })

    const remoteSlot = pool.slot("nas-1")
    const remoteCallSpy = vi.fn(async (method: string, params: unknown) => {
      if (method === "host.identity") {
        return { hostKey: "N".repeat(43), hostName: "Home Linux NAS", runtime: "headless" }
      }
      if (method === "relay.settings")
        return { address: "wss://relay.example/ws/v1/connect", tokenConfigured: true }
      if (method === "host.setName") {
        return {
          hostKey: "N".repeat(43),
          hostName: (params as { name: string }).name,
          runtime: "headless",
        }
      }
      return {}
    })
    remoteSlot.connection.call = remoteCallSpy as unknown as Connection["call"]
    remoteSlot.store.update({ status: "connected" })

    const renameNative = vi.fn().mockResolvedValue(NAS_SUMMARY)
    Object.defineProperty(window, "pigcodeNative", {
      configurable: true,
      value: { platform: "darwin", hosts: { rename: renameNative } },
    })

    render(
      <LocaleProvider locale="zh-CN">
        <SettingsHostScopeContext.Provider
          value={{
            hostPool: pool,
            targetHostId: "nas-1",
            setTargetHostId: () => {},
            onOpenSettingsPage: () => {},
            onStartDraftOnHost: () => false,
          }}
        >
          <DaemonSettingsPage
            deps={{ connection: localConn, store: localStore, plugins: FAKE_PLUGINS }}
          />
        </SettingsHostScopeContext.Provider>
      </LocaleProvider>,
    )

    await waitFor(() => expect(remoteCallSpy).toHaveBeenCalledWith("host.identity", {}))
    expect(localSpy).not.toHaveBeenCalled()

    const nameInput = screen.getByLabelText("主机显示名称") as HTMLInputElement
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, "Cloud NAS")
    await userEvent.click(screen.getByRole("button", { name: "保存名称" }))

    await waitFor(() =>
      expect(remoteCallSpy).toHaveBeenCalledWith("host.setName", { name: "Cloud NAS" }),
    )
    expect(renameNative).toHaveBeenCalledWith("nas-1", "Cloud NAS")
  })
})
