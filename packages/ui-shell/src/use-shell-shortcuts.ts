/** 外壳全局平台标记、全屏状态、快捷键与鼠标后退/前进事件监听 Hook。 */
import { useEffect, useLayoutEffect, type Dispatch, type SetStateAction } from "react"
import { historyStep, type nativePlatform } from "./window-state"

export function useShellShortcuts({
  platform,
  drawerOpen,
  setDrawerOpen,
  setPaletteOpen,
  toggleSidebar,
  sidebarOpen,
  narrow,
  onNewThread,
  onToggleRight,
  onToggleTerminal,
  onView,
  onBack,
  onForward,
}: {
  platform: ReturnType<typeof nativePlatform>
  drawerOpen: boolean
  setDrawerOpen: Dispatch<SetStateAction<boolean>>
  setPaletteOpen: Dispatch<SetStateAction<boolean>>
  toggleSidebar: () => void
  sidebarOpen: boolean | undefined
  narrow: boolean
  onNewThread: (projectId?: string) => void
  onToggleRight?: (() => void) | undefined
  onToggleTerminal?: (() => void) | undefined
  onView: (view: "chat" | "settings" | "schedules") => void
  onBack?: (() => void) | undefined
  onForward?: (() => void) | undefined
}) {
  useEffect(() => {
    if (!drawerOpen) return
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setDrawerOpen(false)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [drawerOpen, setDrawerOpen])

  // 标题栏、交通灯留白和配色按平台区分，CSS 依赖 html[data-platform]；绘制前写入，避免布局跳动。
  useLayoutEffect(() => {
    document.documentElement.dataset.platform = platform
  }, [platform])

  // macOS 全屏时交通灯隐藏，CSS 依赖 html[data-fullscreen] 收回留白。
  useEffect(() => {
    const bridge = window.pigcodeNative
    if (!bridge?.onFullScreenChange) return
    const root = document.documentElement
    const apply = (fullScreen: boolean): void => {
      if (fullScreen) root.dataset.fullscreen = "true"
      else delete root.dataset.fullscreen
    }
    void bridge
      .isFullScreen?.()
      .then(apply)
      .catch(() => undefined)
    return bridge.onFullScreenChange(apply)
  }, [])

  // 全局快捷键：⌘K 面板、⌘N 新会话、⌘B 侧栏、⌘J 右栏、⌃` 底部终端、⌘, 设置。
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === "Backquote") {
        if (!onToggleTerminal) return
        event.preventDefault()
        onToggleTerminal()
        return
      }
      const target = event.target as HTMLElement | null
      const editing =
        target?.isContentEditable === true ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")
      // 输入框和终端里 Alt+方向键是按词移动，不拦截。
      const step = historyStep(event)
      if (step) {
        if (editing) return
        event.preventDefault()
        if (step === "back") onBack?.()
        else onForward?.()
        return
      }
      if (!event.metaKey && !event.ctrlKey) return
      const key = event.key.toLowerCase()
      if (key === "k") {
        event.preventDefault()
        // 对话框打开时不叠一层命令面板：面板会落在对话框下面，回车会在背后执行命令。
        if (document.querySelector(".dialog")) return
        setPaletteOpen((value) => !value)
        return
      }
      if (editing) return
      if (key === "n") {
        event.preventDefault()
        onNewThread()
      } else if (key === "b") {
        event.preventDefault()
        toggleSidebar()
      } else if (key === "j") {
        event.preventDefault()
        onToggleRight?.()
      } else if (event.key === ",") {
        event.preventDefault()
        onView("settings")
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [
    onNewThread,
    onToggleRight,
    onToggleTerminal,
    onView,
    onBack,
    onForward,
    sidebarOpen,
    narrow,
    toggleSidebar,
    setPaletteOpen,
  ])

  // 鼠标侧键的后退与前进。
  useEffect(() => {
    function onMouseUp(event: MouseEvent): void {
      if (event.button === 3) onBack?.()
      else if (event.button === 4) onForward?.()
    }
    window.addEventListener("mouseup", onMouseUp)
    return () => window.removeEventListener("mouseup", onMouseUp)
  }, [onBack, onForward])
}
