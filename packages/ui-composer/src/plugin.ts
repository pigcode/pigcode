/** Composer 插件入口：把输入区注册到 composer 插槽，供宿主按需渲染。 */
import { createElement } from "react"
import type { ClientPluginContext } from "@pigcode/plugin-sdk"
import { Composer, type ComposerProps } from "./composer"

/** slot 宿主未传 props 时使用的空输入区，避免插件被单独加载时崩溃。 */
const EMPTY_PROPS: ComposerProps = {
  onSubmit: () => undefined,
  onStop: () => undefined,
}

/** 注册 composer；返回注销函数。 */
export function apply(ctx: ClientPluginContext): () => void {
  return ctx.slots.register("composer", {
    id: "composer",
    order: 0,
    render: (props: ComposerProps) => createElement(Composer, props ?? EMPTY_PROPS),
  })
}
