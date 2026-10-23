/** 工具行的展开状态按工具 id 记住：折叠的工作区重新展开、标签切回来时保持用户的选择。 */
import { useCallback, useState } from "react"

const manualOpen = new Map<string, boolean>()

/** 用户没动过时用 auto 决定是否展开；动过之后以用户为准。 */
export function useToolOpen(id: string, auto: boolean): [boolean, (open: boolean) => void] {
  const [, rerender] = useState(0)
  const set = useCallback(
    (open: boolean) => {
      manualOpen.set(id, open)
      rerender((value) => value + 1)
    },
    [id],
  )
  return [manualOpen.get(id) ?? auto, set]
}

/** 测试用：忘掉所有工具行的展开状态。 */
export function resetToolOpen(): void {
  manualOpen.clear()
}
