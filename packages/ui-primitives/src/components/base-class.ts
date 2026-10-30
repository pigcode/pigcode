/** 给 Base UI 部件加上固定的类名；调用方传的 className（字符串或按状态返回的函数）接在后面。 */
import { clsx } from "clsx"

type StateClassName<State> = string | ((state: State) => string | undefined) | undefined

export function withBaseClass<State>(
  base: string,
  className: StateClassName<State>,
): string | ((state: State) => string) {
  if (typeof className === "function") return (state) => clsx(base, className(state))
  return clsx(base, className)
}
