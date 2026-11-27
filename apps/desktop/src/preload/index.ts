/** preload：MessagePort 转交 + 最小窗口/主题/菜单桥；不暴露 Node。 */
import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("pigcodeNative", {
  platform: process.platform,
  // Windows 用它判断有没有 acrylic（11 22H2 以上）；沙箱里的 process 也有这个方法
  systemVersion: process.getSystemVersion(),
  appVersion: (): Promise<string> => ipcRenderer.invoke("pigcode:app-version"),
  getUpdateState: (): Promise<import("@pigcode/contracts").DesktopUpdateState> =>
    ipcRenderer.invoke("pigcode:update-state"),
  performUpdate: (): Promise<import("@pigcode/contracts").DesktopUpdateState> =>
    ipcRenderer.invoke("pigcode:update-action"),
  onUpdateState: (listener: (state: import("@pigcode/contracts").DesktopUpdateState) => void) => {
    const handler = (_event: unknown, state: import("@pigcode/contracts").DesktopUpdateState) =>
      listener(state)
    ipcRenderer.on("pigcode:update-state", handler)
    return () => ipcRenderer.removeListener("pigcode:update-state", handler)
  },
  getPreferences: (): Promise<import("../main/preferences").Preferences> =>
    ipcRenderer.invoke("pigcode:preferences-get"),
  setPreference: (
    key: import("../main/preferences").PreferenceKey,
    value: boolean,
  ): Promise<import("../main/preferences").Preferences> =>
    ipcRenderer.invoke("pigcode:preferences-set", key, value),
  pendingReminder: (): Promise<unknown> => ipcRenderer.invoke("pigcode:pending-reminder"),
  finishReminder: (eventId: string): Promise<void> =>
    ipcRenderer.invoke("pigcode:finish-reminder", eventId),
  onReminderReady: (listener: () => void): (() => void) => {
    const signal = () => listener()
    ipcRenderer.on("pigcode:reminder-ready", signal)
    return () => ipcRenderer.removeListener("pigcode:reminder-ready", signal)
  },
  checkForUpdates: (): Promise<{
    status: "up-to-date" | "update-available" | "error"
    version?: string
    url?: string
  }> => ipcRenderer.invoke("pigcode:check-for-updates"),
  setThemeSource: (source: "light" | "dark" | "system") =>
    ipcRenderer.invoke("pigcode:set-theme", source),
  windowControl: (action: "minimize" | "maximize" | "close") =>
    ipcRenderer.invoke("pigcode:window", action),
  isMaximized: () => ipcRenderer.invoke("pigcode:is-maximized"),
  isFullScreen: (): Promise<boolean> => ipcRenderer.invoke("pigcode:is-full-screen"),
  onFullScreenChange: (listener: (fullScreen: boolean) => void): (() => void) => {
    const handler = (_event: unknown, value: unknown) => listener(value === true)
    ipcRenderer.on("pigcode:full-screen", handler)
    return () => {
      ipcRenderer.removeListener("pigcode:full-screen", handler)
    }
  },
  setTitleBarColors: (colors: { color: string; symbolColor: string }) =>
    ipcRenderer.invoke("pigcode:title-bar", colors),
  setWindowTranslucent: (translucent: boolean) =>
    ipcRenderer.invoke("pigcode:set-translucent", translucent),
  saveTextFile: (fileName: string, text: string): Promise<boolean> =>
    ipcRenderer.invoke("pigcode:save-text-file", fileName, text),
  popupMenu: (items: unknown[], position: { x: number; y: number }): Promise<string | null> =>
    ipcRenderer.invoke("pigcode:menu", items, position),
  pickFolder: (labels?: { title?: string; buttonLabel?: string }): Promise<string | null> =>
    ipcRenderer.invoke("pigcode:pick-folder", labels),
  pickPath: (
    kind: "file" | "directory",
    labels?: { title?: string; buttonLabel?: string },
  ): Promise<string | null> => ipcRenderer.invoke("pigcode:pick-path", kind, labels),
  setUnsavedLabels: (labels: {
    message: string
    detail: string
    discard: string
    cancel: string
  }): Promise<void> => ipcRenderer.invoke("pigcode:unsaved-labels", labels),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke("pigcode:open-external", url),
  openFolder: (path: string): Promise<void> => ipcRenderer.invoke("pigcode:open-folder", path),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke("pigcode:reveal-path", path),
  listOpenApps: (): Promise<
    Array<{
      id: string
      name: string
      kind: "file-manager" | "editor" | "terminal"
      icon: string | null
    }>
  > => ipcRenderer.invoke("pigcode:list-open-apps"),
  openWithApp: (appId: string, path: string): Promise<void> =>
    ipcRenderer.invoke("pigcode:open-with-app", appId, path),
  openWorkspaceFile: (root: string, path: string, appId: string | null): Promise<void> =>
    ipcRenderer.invoke("pigcode:open-workspace-file", root, path, appId),
  saveWorkspaceFile: (root: string, path: string): Promise<boolean> =>
    ipcRenderer.invoke("pigcode:save-workspace-file", root, path),
  previewOpen: (url: string): Promise<{ id: string }> =>
    ipcRenderer.invoke("pigcode:preview-open", url),
  previewClose: (id?: string): void => {
    void ipcRenderer.invoke("pigcode:preview-close", id).catch(() => undefined)
  },
  hosts: {
    getState: (): Promise<{
      hosts: import("@pigcode/contracts").HostSummary[]
      defaults: import("@pigcode/contracts").HostDefaults
      pairing: import("@pigcode/contracts").HostOutboundPairingStatus
    }> => ipcRenderer.invoke("pigcode:hosts-state"),
    setLocalKey: (hostKey: string): Promise<void> =>
      ipcRenderer.invoke("pigcode:hosts-local-key", hostKey),
    startPairing: (input: {
      link: string
      customName?: string
      badgeColor?: import("@pigcode/contracts").HostBadgeColor
    }): Promise<import("@pigcode/contracts").HostOutboundPairingStatus> =>
      ipcRenderer.invoke("pigcode:hosts-pair-start", input),
    cancelPairing: (): Promise<import("@pigcode/contracts").HostOutboundPairingStatus> =>
      ipcRenderer.invoke("pigcode:hosts-pair-cancel"),
    reconnect: (id: string): Promise<import("@pigcode/contracts").HostSummary | null> =>
      ipcRenderer.invoke("pigcode:hosts-reconnect", id),
    rename: (id: string, name: string): Promise<import("@pigcode/contracts").HostSummary | null> =>
      ipcRenderer.invoke("pigcode:hosts-rename", id, name),
    setBadgeColor: (
      id: string,
      color: import("@pigcode/contracts").HostBadgeColor,
    ): Promise<import("@pigcode/contracts").HostSummary | null> =>
      ipcRenderer.invoke("pigcode:hosts-color", id, color),
    remove: (id: string): Promise<boolean> => ipcRenderer.invoke("pigcode:hosts-remove", id),
    setDefault: (hostId: string): Promise<import("@pigcode/contracts").HostDefaults> =>
      ipcRenderer.invoke("pigcode:hosts-set-default", hostId),
    onHostsChanged: (
      listener: (payload: {
        hosts: import("@pigcode/contracts").HostSummary[]
        defaults: import("@pigcode/contracts").HostDefaults
      }) => void,
    ): (() => void) => {
      const handler = (
        _event: unknown,
        payload: {
          hosts: import("@pigcode/contracts").HostSummary[]
          defaults: import("@pigcode/contracts").HostDefaults
        },
      ) => listener(payload)
      ipcRenderer.on("pigcode:hosts-changed", handler)
      return () => ipcRenderer.removeListener("pigcode:hosts-changed", handler)
    },
    onPairingChanged: (
      listener: (state: import("@pigcode/contracts").HostOutboundPairingStatus) => void,
    ): (() => void) => {
      const handler = (
        _event: unknown,
        state: import("@pigcode/contracts").HostOutboundPairingStatus,
      ) => listener(state)
      ipcRenderer.on("pigcode:hosts-pairing-state", handler)
      return () => ipcRenderer.removeListener("pigcode:hosts-pairing-state", handler)
    },
  },
  browser: {
    register: (sessionId: string, threadId: string, webContentsId: number): Promise<void> =>
      ipcRenderer.invoke("pigcode:browser-register", sessionId, threadId, webContentsId),
    unregister: (sessionId: string): void => {
      void ipcRenderer.invoke("pigcode:browser-unregister", sessionId).catch(() => undefined)
    },
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke("pigcode:browser-external", url),
    saveLink: (url: string): Promise<void> => ipcRenderer.invoke("pigcode:browser-save-link", url),
    onOpen: (listener: (request: { threadId: string; url: string | null }) => void) => {
      const handler = (_event: unknown, value: { threadId: string; url: string | null }) =>
        listener(value)
      ipcRenderer.on("pigcode:browser-open", handler)
      return () => {
        ipcRenderer.removeListener("pigcode:browser-open", handler)
      }
    },
    onActivity: (
      listener: (activity: {
        threadId: string
        sessionId: string
        action: string
        detail: string
        point?: { x: number; y: number }
      }) => void,
    ) => {
      const handler = (_event: unknown, value: Parameters<typeof listener>[0]) => listener(value)
      ipcRenderer.on("pigcode:browser-activity", handler)
      return () => {
        ipcRenderer.removeListener("pigcode:browser-activity", handler)
      }
    },
  },
})

ipcRenderer.on("pigcode:port", (event) => {
  const [port] = event.ports
  if (port) window.postMessage({ type: "pigcode:port" }, "*", [port])
})

ipcRenderer.on("pigcode:remote-port", (event, payload: unknown) => {
  const [port] = event.ports
  const hostId =
    typeof payload === "object" && payload !== null && "hostId" in payload
      ? (payload as { hostId?: unknown }).hostId
      : undefined
  if (typeof hostId === "string" && port) {
    window.postMessage({ type: "pigcode:remote-port", hostId }, "*", [port])
  }
})
