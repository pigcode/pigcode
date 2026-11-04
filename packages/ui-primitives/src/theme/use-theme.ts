/**
 * 宿主的明暗主题 hook：读根元素的 `data-theme`（外观设置的唯一写入口），变化时通知组件。
 *
 * 和 `@pigcode/client-runtime` 的 observeTheme 读的是同一个属性；放在 ui-primitives 是因为它也是插件的
 * 共享模块（ADR-0002）：插件里 `import { useTheme } from "@pigcode/ui-primitives"` 用到的是宿主这份
 * React，context 与状态不会分成两份。
 */
import { useSyncExternalStore } from "react"

/** 宿主的明暗主题。 */
export type Theme = "light" | "dark"

/** 读根元素的 data-theme；缺省按浅色。 */
function readTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light"
}

/** 订阅 data-theme 的变化。 */
function subscribe(listener: () => void): () => void {
  const observer = new MutationObserver(listener)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] })
  return () => observer.disconnect()
}

/** 组件里读取当前主题；主题切换后自动重画。 */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme, () => "light")
}
