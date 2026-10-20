// 负责把外观推导结果写到根元素上：先清掉上一次写过而这次不再需要的项，再写入新的。
import type { AppearanceOutput } from "./appearance-tokens"

/** applyAppearance 需要的根元素能力；HTMLElement 满足它，测试里可以用假对象。 */
export type AppearanceRoot = {
  style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">
  setAttribute: (name: string, value: string) => void
  removeAttribute: (name: string) => void
}

/**
 * 把 output 写到 root 上。保证：previous 有而 output 没有的变量和属性先被移除，
 * 随后写入 output 的全部项；previous 为 null 时只写入。不会碰 previous 之外的项。
 */
export function applyAppearance(
  root: AppearanceRoot,
  output: AppearanceOutput,
  previous: AppearanceOutput | null,
): void {
  if (previous) {
    for (const name of Object.keys(previous.vars)) {
      if (!(name in output.vars)) root.style.removeProperty(name)
    }
    for (const name of Object.keys(previous.attrs)) {
      if (!(name in output.attrs)) root.removeAttribute(name)
    }
  }
  for (const [name, value] of Object.entries(output.vars)) root.style.setProperty(name, value)
  for (const [name, value] of Object.entries(output.attrs)) root.setAttribute(name, value)
}
