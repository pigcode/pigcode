/** ⌘/Ctrl+1…9 按当前显示的顺序打开侧栏会话，输入框里同样生效。 */
import { useEffect } from "react"
import type { Thread } from "@pigcode/contracts"
import { threadShortcutIndex } from "./window-state"

export function useThreadShortcuts({
  enabled,
  threads,
  onOpen,
}: {
  enabled: boolean
  threads: readonly Thread[]
  onOpen: (threadId: string) => void
}): void {
  useEffect(() => {
    if (!enabled) return
    function onKeyDown(event: KeyboardEvent): void {
      const index = threadShortcutIndex(event)
      if (index === null) return
      const target = threads[index - 1]
      if (!target) return
      event.preventDefault()
      onOpen(target.id)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, threads, onOpen])
}
