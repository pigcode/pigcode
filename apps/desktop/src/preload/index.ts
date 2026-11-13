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
  getPreferences: (): Promise<{
    launchAtLogin: boolean
    showInDock: boolean
    autoCheckUpdates: boolean
    prereleaseUpdates: boolean
    keepAwake: boolean
  }> => ipcRenderer.invoke("pigcode:preferences-get"),
  setPreference: (
    key: "launchAtLogin" | "showInDock" | "autoCheckUpdates" | "prereleaseUpdates" | "keepAwake",
    value: boolean,
  ): Promise<{
    launchAtLogin: boolean
    showInDock: boolean
    autoCheckUpdates: boolean
    prereleaseUpdates: boolean
    keepAwake: boolean
  }> => ipcRenderer.invoke("pigcode:preferences-set", key, value),
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
