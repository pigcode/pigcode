/** 验证多主机工作区混排 / 按主机切换、远程项目目录浏览、远程打开守护与 Paseo 设置侧栏作用域。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { HostSummary } from "@pigcode/contracts"
import { ExtensionRegistryScope, createExtensionRegistry } from "@pigcode/client-runtime"
import { LocaleProvider } from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AddProjectDialog } from "./add-project-dialog"
import { OpenInRow } from "./open-in"
import { SettingsSidebar } from "./settings-sidebar"
import { Shell } from "./shell"
import { ToastProvider } from "./toast"
import { chooseMenuItem, mockMenu, project, thread } from "./sidebar.fixtures"
import { WorkspaceSidebar } from "./workspace-sidebar"

const LOCAL_HOST: HostSummary = {
  id: "local",
  name: "Studio Mac",
  hostKey: "L".repeat(43),
  kind: "local",
  badgeColor: "blue",
  status: "connected",
  channel: "local",
  latencyMs: 0,
  lanAddresses: [],
  relayAddress: null,
  lastConnectedAt: 1000,
  lastError: null,
}

const NAS_ONLINE: HostSummary = {
  id: "nas-1",
  name: "Home NAS",
  hostKey: "N".repeat(43),
  kind: "headless",
  badgeColor: "green",
  status: "connected",
  channel: "relay",
  latencyMs: 28,
  lanAddresses: [],
  relayAddress: "wss://relay.example/ws/v1/connect",
  lastConnectedAt: 2000,
  lastError: null,
}

const GPU_OFFLINE: HostSummary = {
  id: "gpu-1",
  name: "Office GPU",
  hostKey: "G".repeat(43),
  kind: "desktop",
  badgeColor: "amber",
  status: "offline",
  channel: "lan",
  latencyMs: null,
  lanAddresses: ["ws://192.168.1.9:39000/ws"],
  relayAddress: null,
  lastConnectedAt: 1000,
  lastError: "unreachable",
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  Reflect.deleteProperty(window, "pigcodeNative")
})

describe("Multi-host WorkspaceSidebar & Shell", () => {
  it("renders mixed host badges by default, switches to by-host groups, and omits local Finder reveal on remote projects", async () => {
    const pLocal = project("p-local", "pigcode")
    const pNas = project("p-nas", "nas-worker")
    const pGpu = project("p-gpu", "cached-gpu")
    const tLocal = thread("t-local", "p-local", "Local thread", "2026-11-28T01:00:00.000Z")
    const tGpu = thread("t-gpu", "p-gpu", "Cached offline thread", "2026-11-28T02:00:00.000Z")
    const menu = mockMenu()
    const onAddProjectOnHost = vi.fn()

    render(
      <LocaleProvider locale="zh-CN">
        <ToastProvider>
          <WorkspaceSidebar
            projects={[pLocal, pNas, pGpu]}
            threads={[tLocal, tGpu]}
            activeThreadId={null}
            expandedProjects={{ "p-local": true, "p-nas": true, "p-gpu": true }}
            hosts={[LOCAL_HOST, NAS_ONLINE, GPU_OFFLINE]}
            hostOfProject={{ "p-local": LOCAL_HOST, "p-nas": NAS_ONLINE, "p-gpu": GPU_OFFLINE }}
            hostOfThread={{ "t-local": LOCAL_HOST, "t-gpu": GPU_OFFLINE }}
            onAddProject={() => {}}
            onAddProjectOnHost={onAddProjectOnHost}
            onToggleProject={() => {}}
            onOpenThread={() => {}}
            onNewThread={() => {}}
            onRenameProject={vi.fn()}
            onRemoveProject={vi.fn()}
          />
        </ToastProvider>
      </LocaleProvider>,
    )

    // Mixed layout is default and displays host badges.
    expect(screen.getByRole("button", { name: "混排" }).getAttribute("aria-pressed")).toBe("true")
    expect(screen.getAllByText("Home NAS").length).toBeGreaterThan(0)
    expect(screen.getAllByTitle("Office GPU · 离线").length).toBeGreaterThan(0)

    // Remote project context menu does not offer local macOS/Linux file manager reveal.
    await chooseMenuItem(menu, screen.getByRole("button", { name: "nas-worker" }), "rename")
    const menuItems = (menu.mock.lastCall?.[0] ?? []) as ReadonlyArray<{ id?: string }>
    expect(menuItems.some((item) => item.id === "open-folder")).toBe(false)
    expect(menuItems.some((item) => item.id === "rename")).toBe(true)

    // Switch to "按主机" grouped mode and click per-host add project on Home NAS.
    fireEvent.click(screen.getByRole("button", { name: "按主机" }))
    expect(window.localStorage.getItem("pigcode.hostLayout")).toBe("host")
    fireEvent.click(screen.getByRole("button", { name: "添加项目 (Home NAS)" }))
    expect(onAddProjectOnHost).toHaveBeenCalledWith("nas-1")
  })

  it("shows host cluster summary pill and add remote host trigger in Shell footer", () => {
    const onOpenHostsSettings = vi.fn()
    const onOpenAddHost = vi.fn()
    render(
      <LocaleProvider locale="zh-CN">
        <Shell
          view="chat"
          projects={[]}
          threads={[]}
          activeThreadId={null}
          hosts={[LOCAL_HOST, NAS_ONLINE, GPU_OFFLINE]}
          activeHostId="local"
          onOpenHostsSettings={onOpenHostsSettings}
          onOpenAddHost={onOpenAddHost}
          onView={() => {}}
          onAddProject={() => {}}
          onNewThread={() => {}}
          onOpenThread={() => {}}
        >
          <div>body</div>
        </Shell>
      </LocaleProvider>,
    )

    const foot = document.querySelector(".side-foot") as HTMLElement
    fireEvent.click(within(foot).getByRole("button", { name: /主机 · 2\/3/ }))
    expect(onOpenHostsSettings).toHaveBeenCalledTimes(1)
    fireEvent.click(within(foot).getByRole("button", { name: "添加远程主机" }))
    expect(onOpenAddHost).toHaveBeenCalledTimes(1)
  })

  it("browses remote directories via browseRemoteDirs inside AddProjectDialog", async () => {
    const browseRemoteDirs = vi
      .fn()
      .mockResolvedValueOnce({
        path: "/home/dev",
        parentPath: "/home",
        homePath: "/home/dev",
        entries: [
          { name: "workspace", path: "/home/dev/workspace", isGitRepo: true, hasChildren: true },
        ],
      })
      .mockResolvedValueOnce({
        path: "/home/dev/workspace",
        parentPath: "/home/dev",
        homePath: "/home/dev",
        entries: [],
      })
    const onAdd = vi.fn()

    render(
      <LocaleProvider locale="zh-CN">
        <AddProjectDialog
          open
          onOpenChange={() => {}}
          hosts={[LOCAL_HOST, NAS_ONLINE]}
          targetHostId="nas-1"
          browseRemoteDirs={browseRemoteDirs}
          onAdd={onAdd}
        />
      </LocaleProvider>,
    )

    const folderBtn = await screen.findByRole("button", { name: /workspace/ })
    await userEvent.click(folderBtn)
    await waitFor(() =>
      expect(browseRemoteDirs).toHaveBeenCalledWith("nas-1", "/home/dev/workspace"),
    )
    await userEvent.click(screen.getByRole("button", { name: "添加" }))
    expect(onAdd).toHaveBeenCalledWith("/home/dev/workspace", undefined, "nas-1")
  })

  it("replaces local OpenIn launcher with copy-path only when project is remote", () => {
    const listOpenApps = vi.fn()
    Object.defineProperty(window, "pigcodeNative", {
      configurable: true,
      value: { platform: "darwin", listOpenApps },
    })
    render(
      <LocaleProvider locale="zh-CN">
        <ToastProvider>
          <OpenInRow path="/srv/repo/app" isRemote />
        </ToastProvider>
      </LocaleProvider>,
    )
    expect(listOpenApps).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "复制路径" })).toBeTruthy()
  })

  it("splits SettingsSidebar into App & Connections and Paseo Host Scope when hosts are provided", async () => {
    const registry = createExtensionRegistry()
    const Glyph = () => <svg />
    registry.register("settingsPage", {
      id: "general",
      owner: { kind: "builtin", id: "settings" },
      order: 10,
      title: { key: "settings.general" },
      icon: Glyph,
      render: () => null,
    })
    registry.register("settingsPage", {
      id: "remote-hosts",
      owner: { kind: "builtin", id: "settings" },
      order: 20,
      title: { key: "settings.remoteHosts" },
      icon: Glyph,
      render: () => null,
    })
    registry.register("settingsPage", {
      id: "agents",
      owner: { kind: "builtin", id: "host-scope" },
      order: 30,
      title: { key: "settings.agents" },
      icon: Glyph,
      render: () => null,
    })
    const onSelectSettingsHost = vi.fn()

    render(
      <ExtensionRegistryScope registry={registry}>
        <LocaleProvider locale="zh-CN">
          <SettingsSidebar
            activePage="agents"
            onSelect={() => {}}
            onExit={() => {}}
            hosts={[LOCAL_HOST, NAS_ONLINE]}
            settingsHostId="local"
            onSelectSettingsHost={onSelectSettingsHost}
          />
        </LocaleProvider>
      </ExtensionRegistryScope>,
    )

    expect(screen.getByText("应用与连接")).toBeTruthy()
    expect(screen.getByText("当前配置主机")).toBeTruthy()
    const scopeTrigger = screen.getByRole("button", { name: "运行主机" })
    await userEvent.click(scopeTrigger)
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Home NAS/ }))
    expect(onSelectSettingsHost).toHaveBeenCalledWith("nas-1")
  })
})
