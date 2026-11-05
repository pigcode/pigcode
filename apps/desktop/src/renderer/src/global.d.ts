/** preload 暴露的最小原生桥；渲染进程不直接访问 Node。 */
interface Window {
  pigcodeNative?: {
    platform: string
    appVersion?(): Promise<string>
    setThemeSource(source: "light" | "dark" | "system"): Promise<void>
    windowControl(action: "minimize" | "maximize" | "close"): Promise<void>
    isMaximized(): Promise<boolean>
    isFullScreen?(): Promise<boolean>
    onFullScreenChange?(listener: (fullScreen: boolean) => void): () => void
    setTitleBarColors?(colors: { color: string; symbolColor: string }): Promise<void>
    popupMenu?(
      items: ReadonlyArray<
        | { type: "separator" }
        | { id: string; label: string; accelerator?: string; enabled?: boolean }
        | { role: string; label?: string }
      >,
      position: { x: number; y: number },
    ): Promise<string | null>
    pickFolder?(labels?: { title?: string; buttonLabel?: string }): Promise<string | null>
    /** 选择一个文件或文件夹（显示隐藏文件）；取消时为 null。 */
    pickPath?(
      kind: "file" | "directory",
      labels?: { title?: string; buttonLabel?: string },
    ): Promise<string | null>
    /** 关闭窗口时「有未保存的修改」确认框的文案。 */
    setUnsavedLabels?(labels: {
      message: string
      detail: string
      discard: string
      cancel: string
    }): Promise<void>
    /** 用系统浏览器打开不带凭据的 https 链接。 */
    openExternal?(url: string): Promise<void>
    /** 在系统文件管理器里打开文件夹；不是已存在的目录时拒绝。 */
    openFolder?(path: string): Promise<void>
    /** 在系统文件管理器里选中一个文件或文件夹；路径不存在时拒绝。 */
    revealPath?(path: string): Promise<void>
    /** 本机装了的文件管理器、编辑器与终端；icon 是 data URL，取不到时为 null。 */
    listOpenApps?(): Promise<
      Array<{
        id: string
        name: string
        kind: "file-manager" | "editor" | "terminal"
        icon: string | null
      }>
    >
    /** 用指定应用打开文件夹；不是已存在的目录或应用不在本机时拒绝。 */
    openWithApp?(appId: string, path: string): Promise<void>
    previewOpen(url: string): Promise<{ id: string }>
    previewClose(id?: string): void
    /** 右栏内置浏览器：登记 webview，接收 agent 打开浏览器与操作的通知。 */
    browser?: {
      register(sessionId: string, threadId: string, webContentsId: number): Promise<void>
      unregister(sessionId: string): void
      onOpen(listener: (request: { threadId: string; url: string | null }) => void): () => void
      onActivity(
        listener: (activity: {
          threadId: string
          sessionId: string
          action: string
          detail: string
          point?: { x: number; y: number }
        }) => void,
      ): () => void
    }
  }
}
