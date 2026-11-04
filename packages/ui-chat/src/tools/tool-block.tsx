/**
 * 时间线里的一个工具调用：取第一个匹配的工具渲染器，都不匹配时用通用渲染器。ui-chat 不依赖扩展点
 * 注册表；窗口把工具渲染器扩展点上的内容（已按优先级排好）通过 ToolRenderersContext 传进来，
 * 内容变化时这里跟着重渲染，所以插件停用后时间线立即换回去。
 */
import { createContext, memo, useContext, type ReactNode } from "react"
import type { ToolCall } from "../tool-meta"
import { FallbackRow } from "./misc"

/** 工具渲染器的 render 收到的参数。 */
export interface ToolRenderProps {
  tool: ToolCall
  /** 运行中的命令已经流出的输出；只传给命令的渲染器。 */
  live?: string | undefined
  /** 分组里的子项不显示图标。 */
  showIcon: boolean
}

/**
 * 一个工具渲染器。两个成员都写成函数属性：这样参数按严格的逆变检查，窗口传进来的渲染器
 * 和这里的 ToolCall 不兼容时过不了类型检查。
 */
export interface ToolRendererEntry {
  matches: (name: string) => boolean
  render: (props: ToolRenderProps) => ReactNode
}

/** 按优先级排好的工具渲染器；缺省没有，全部工具都用通用渲染器。 */
export const ToolRenderersContext = createContext<readonly ToolRendererEntry[]>([])

/** 渲染一个工具调用。live 是运行中命令已经流出的输出；分组里的子项不显示图标。 */
export const ToolBlock = memo(function ToolBlock({
  tool,
  live,
  showIcon = true,
}: {
  tool: ToolCall
  live?: string | undefined
  showIcon?: boolean | undefined
}) {
  const renderers = useContext(ToolRenderersContext)
  const renderer = renderers.find((item) => item.matches(tool.name))
  if (!renderer) return <FallbackRow tool={tool} showIcon={showIcon} />
  return renderer.render({ tool, live, showIcon })
})
