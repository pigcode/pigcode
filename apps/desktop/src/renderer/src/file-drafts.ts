/**
 * 文件标签里未保存的修改：按「线程 + 路径」保存在模块里。右侧面板只挂载当前标签，
 * 草稿放在组件外，切换标签、收起面板或切换线程后都还在；标签栏据此显示未保存的圆点。
 */
import { useSyncExternalStore } from "react"

const drafts = new Map<string, string>()
const listeners = new Set<() => void>()
let version = 0

function keyOf(threadId: string, path: string): string {
  return `${threadId}\n${path}`
}

/** 读取草稿；没有修改时为 null。 */
export function getDraft(threadId: string, path: string): string | null {
  return drafts.get(keyOf(threadId, path)) ?? null
}

/** 写入或清除草稿（null）。 */
export function setDraft(threadId: string, path: string, text: string | null): void {
  const key = keyOf(threadId, path)
  if (text === null ? !drafts.has(key) : drafts.get(key) === text) return
  if (text === null) drafts.delete(key)
  else drafts.set(key, text)
  version += 1
  for (const listener of [...listeners]) listener()
}

/** 是否还有没保存的修改；关闭或刷新窗口前据此拦一下。 */
export function hasDrafts(): boolean {
  return drafts.size > 0
}

/** 草稿变化时递增的版本号，供组件重新读取。 */
export function useDraftVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => version,
  )
}
