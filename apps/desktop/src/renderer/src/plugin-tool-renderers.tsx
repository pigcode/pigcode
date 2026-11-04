/**
 * 插件的工具渲染器：检查登记内容，把声明的工具名和工具族换成扩展点上的 matches，把 DOM 内容放进插件
 * 内容的挂载点。匹配只比较名字，渲染时间线时不运行插件代码。
 */
import { useMemo, type ComponentType } from "react"
import type {
  ContributionOwner,
  ToolRendererCall,
  ToolRendererContribution,
} from "@pigcode/client-runtime"
import type {
  ClientRender,
  ClientToolCall,
  ClientToolFamily,
  ClientToolRender,
  ClientToolRenderer,
} from "@pigcode/plugin-sdk"
import { mcpParts, toolFamily, type ToolFamily } from "@pigcode/ui-chat"
import { PluginContentHost } from "@pigcode/ui-shell"

/** 两个联合类型是否完全相同。 */
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * 插件可以声明的工具族。下面的表格按 ToolFamily 检查，这个常量的类型再要求 SDK 的 ClientToolFamily 和
 * ToolFamily 完全相同：任何一边多或少一个族名都过不了类型检查。
 */
const KNOWN_FAMILIES: SameUnion<ClientToolFamily, ToolFamily> extends true
  ? ReadonlySet<string>
  : never = new Set(
  Object.keys({
    "file-read": true,
    "file-write": true,
    shell: true,
    search: true,
    "web-fetch": true,
    todo: true,
    "ask-user-question": true,
    agent: true,
    skill: true,
    "task-output": true,
    "task-stop": true,
    message: true,
    "plan-guidance": true,
    "switch-mode": true,
    mcp: true,
    browser: true,
    unknown: true,
  } satisfies Record<ToolFamily, true>),
)

/** 是不是非空字符串组成的数组。 */
function isNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item !== "")
}

/**
 * 检查插件传来的工具渲染器。插件可以是没有类型检查的 JS：这里直接抛出，在 apply 里登记时就记成这个插件的
 * 界面代码错误，不会等到时间线渲染时才出错。工具渲染器没有标题，所以不用 checkContribution。
 * 内容必须恰好给一种：`Component`（宿主的 React 组件）或 `render`（DOM 渲染函数）。
 */
export function checkToolRenderer(renderer: {
  id?: unknown
  order?: unknown
  tools?: unknown
  families?: unknown
  render?: unknown
  Component?: unknown
}): ToolRendererContent {
  const { tools, families } = renderer
  const hasRender = typeof renderer.render === "function"
  const hasComponent = isComponent(renderer.Component)
  const checks: Array<[boolean, string]> = [
    [typeof renderer.id === "string" && renderer.id !== "", "id must be a non-empty string"],
    [hasRender !== hasComponent, "give exactly one of render or Component"],
    [renderer.order === undefined || Number.isFinite(renderer.order), "order must be a number"],
    [tools === undefined || isNameList(tools), "tools must be an array of non-empty strings"],
    [
      families === undefined ||
        (isNameList(families) && families.every((family) => KNOWN_FAMILIES.has(family))),
      "families must be an array of tool family names",
    ],
    [
      (Array.isArray(tools) && tools.length > 0) ||
        (Array.isArray(families) && families.length > 0),
      "tools or families must list at least one name",
    ],
  ]
  const problem = checks.find(([ok]) => !ok)?.[1]
  if (problem) throw new TypeError(`toolRenderers.register: ${problem}`)
  // 返回检查过的那一种内容，调用方不再自己猜：插件同时传了无效的另一个字段时也不会走错分支。
  return hasRender
    ? { render: renderer.render as ClientToolRender }
    : { Component: renderer.Component as ComponentType<{ tool: ClientToolCall }> }
}

/**
 * 是不是一个 React 组件。`memo`、`forwardRef`、`lazy` 返回的是带 `$$typeof` 的对象，不是函数；
 * 它们都是合法的 ComponentType。判断和 client-plugins 的 checkContribution 一致。
 */
function isComponent(value: unknown): value is ComponentType {
  if (typeof value === "function") return true
  return typeof value === "object" && value !== null && "$$typeof" in value
}

/** 时间线里一次调用的插件内容：调用的状态、输入或输出变了才重画，别的渲染不打断插件的 DOM。 */
function PluginToolContent({
  id,
  draw,
  tool,
}: {
  id: string
  draw: ClientToolRender
  tool: ToolRendererCall
}) {
  // inputValue、outputValue 是 input、output 的原样形式，不用单独比较。
  const render = useMemo<ClientRender>(
    () => (container) => draw(container, { ...tool }),
    [
      draw,
      tool.id,
      tool.name,
      tool.status,
      tool.input,
      tool.output,
      tool.startedAt,
      tool.endedAt,
      tool.exitCode,
    ],
  )
  return <PluginContentHost id={id} render={render} kind="tool" />
}

/**
 * 用 React 写的工具渲染器：组件收 `tool`，只在调用变化时换一个组件类型，组件自己的状态在别的时候保留。
 */
function PluginToolComponent({
  id,
  Component,
  tool,
}: {
  id: string
  Component: ComponentType<{ tool: ClientToolCall }>
  tool: ToolRendererCall
}) {
  const Bound = useMemo(
    () => () => <Component tool={tool} />,
    [
      Component,
      tool.id,
      tool.name,
      tool.status,
      tool.input,
      tool.output,
      tool.startedAt,
      tool.endedAt,
      tool.exitCode,
    ],
  )
  return <PluginContentHost id={id} Component={Bound} kind="tool" />
}

/** 检查过的工具渲染内容：组件或 DOM 渲染函数，二选一。 */
export type ToolRendererContent =
  { render: ClientToolRender } | { Component: ComponentType<{ tool: ClientToolCall }> }

/** 把检查过的插件工具渲染器换成扩展点上的 Contribution。 */
export function pluginToolRenderer(
  renderer: ClientToolRenderer,
  content: ToolRendererContent,
  owner: ContributionOwner,
): ToolRendererContribution {
  // 登记时复制一份：插件之后改自己的数组也不影响匹配。
  const tools = new Set(renderer.tools ?? [])
  const families = new Set<ClientToolFamily>(renderer.families ?? [])
  // 包一层：每次渲染都传新函数会让 PluginToolContent 的 useMemo 失效，调用没变也会重画插件的 DOM。
  const draw =
    "render" in content
      ? (container: HTMLElement, call: ClientToolCall) => content.render(container, call)
      : null
  return {
    id: renderer.id,
    owner,
    order: renderer.order ?? 0,
    matches(name) {
      const mcpTool = mcpParts(name)?.tool
      return (
        tools.has(name) ||
        (mcpTool !== undefined && tools.has(mcpTool)) ||
        families.has(toolFamily(name))
      )
    },
    render: ({ tool }) =>
      "Component" in content ? (
        <PluginToolComponent id={renderer.id} Component={content.Component} tool={tool} />
      ) : (
        <PluginToolContent id={renderer.id} draw={draw as ClientToolRender} tool={tool} />
      ),
  }
}
