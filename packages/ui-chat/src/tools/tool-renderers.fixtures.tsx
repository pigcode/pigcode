/**
 * ui-chat 测试共用的工具渲染器：和窗口登记的一样，用内置的工具行按族选工具行。ui-chat 自己不登记
 * 渲染器，测试里没有它们时全部工具都是通用行。
 */
import type { ReactNode } from "react"
import { toolFamily } from "../tool-identity"
import { BUILTIN_TOOL_ROWS } from "./builtin-rows"
import { ToolRenderersContext, type ToolRendererEntry } from "./tool-block"

const RENDERERS: readonly ToolRendererEntry[] = BUILTIN_TOOL_ROWS.map(([family, render]) => ({
  matches: (name) => toolFamily(name) === family,
  render,
}))

/** 让下面的时间线组件用和窗口一样的工具行。 */
export function WithToolRenderers({ children }: { children: ReactNode }) {
  return <ToolRenderersContext.Provider value={RENDERERS}>{children}</ToolRenderersContext.Provider>
}
