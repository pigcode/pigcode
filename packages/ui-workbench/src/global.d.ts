/** preload 暴露的最小原生桥；渲染进程不直接访问 Node。 */
interface Window {
  pigcodeNative?: {
    platform: string
    setThemeSource(source: "light" | "dark" | "system"): Promise<void>
    windowControl(action: "minimize" | "maximize" | "close"): Promise<void>
    isMaximized(): Promise<boolean>
    previewOpen(url: string): Promise<{ id: string }>
    previewClose(id?: string): void
  }
}

/** 与 ui-primitives 保持一致的 Vite 环境声明，供跨包 typecheck 使用。 */
interface ImportMetaEnv {
  readonly DEV: boolean
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
