/** 右侧面板的标签标题；各 surface 自己的文案由组件按当前 locale 读取。 */
import type { MessageKey } from "@pigcode/ui-primitives"
import { SURFACE_LABELS, type SurfaceKind } from "@pigcode/ui-workbench"

/** useLocale() 暴露的 t 函数签名。 */
export type Translate = (key: MessageKey) => string

/** 新标签的标题；终端与浏览器按序号区分。 */
export function surfaceTitle(t: Translate, kind: SurfaceKind, index: number): string {
  const name = t(SURFACE_LABELS[kind])
  if (kind === "terminal") return `${name} ${index}`
  if (kind === "browser" && index > 1) return `${name} ${index}`
  return name
}
