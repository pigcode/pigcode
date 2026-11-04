/**
 * 内置工具渲染器登记到工具渲染器扩展点，每个工具族一个；扩展点上的内容再通过 ToolRenderersContext
 * 交给时间线（ui-chat 不依赖注册表，和 Surface 的做法一样）。工具行本身在 ui-chat 的
 * BUILTIN_TOOL_ROWS 里，测试也用同一份表。其余的族和不认识的工具没有渲染器，时间线用通用渲染器显示。
 */
import type { ReactNode } from "react"
import {
  BUILTIN_TOOL_RENDERER_ORDER,
  useContributions,
  type ContributionOwner,
  type ExtensionRegistry,
} from "@pigcode/client-runtime"
import { BUILTIN_TOOL_ROWS, ToolRenderersContext, toolFamily } from "@pigcode/ui-chat"

/** 内置工具渲染器的归属。 */
const TOOL_RENDERERS_OWNER: ContributionOwner = { kind: "builtin", id: "toolRenderers" }

/** 把内置工具渲染器登记到注册表。 */
export function registerBuiltinToolRenderers(extensions: ExtensionRegistry): void {
  for (const [family, render] of BUILTIN_TOOL_ROWS) {
    extensions.register("toolRenderer", {
      id: `builtin.${family}`,
      owner: TOOL_RENDERERS_OWNER,
      order: BUILTIN_TOOL_RENDERER_ORDER,
      matches: (name) => toolFamily(name) === family,
      render,
    })
  }
}

/** 把工具渲染器扩展点上的内容交给下面的时间线；主时间线和子 agent 的标签页都在它里面。 */
export function ToolRenderersScope({ children }: { children: ReactNode }) {
  const renderers = useContributions("toolRenderer")
  return <ToolRenderersContext.Provider value={renderers}>{children}</ToolRenderersContext.Provider>
}
