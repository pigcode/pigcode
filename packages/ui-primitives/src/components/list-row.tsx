/**
 * 列表行：左侧图标或头像，标题与一行说明，右侧补充信息与操作。侧栏、设置分组、Agent 与插件列表、
 * 模型列表、命令面板和文件树都用它；样式在 list-rows.css。
 */
import { useRender } from "@base-ui/react/use-render"
import type { ComponentProps, ReactElement, ReactNode } from "react"
import { cn } from "./cn"

export type ListRowProps = Omit<ComponentProps<"div">, "title" | "children"> & {
  /** 替换默认的 div；整行可点、里面没有别的按钮时传 `<button type="button" />`。 */
  render?: ReactElement
  /** 图标、头像、状态点，或文件树的参考线、展开箭头与文件图标。 */
  leading?: ReactNode
  title: ReactNode
  /** 合并到 .list-row-title 上的属性，比如额外的类名或 title。 */
  titleProps?: ComponentProps<"span">
  /** 标题下面的一行说明。 */
  description?: ReactNode
  /** 右侧的补充信息：时间、快捷键、版本、git 标记、箭头或勾。 */
  meta?: ReactNode
  /** 最右侧的控件：开关、图标按钮、星标。 */
  actions?: ReactNode
  /**
   * 行里有操作、又要有一个主点击目标时传入：标题换成按钮，按钮的 ::after 盖住整行，
   * 操作叠在它上面。
   */
  button?: ComponentProps<"button">
  density?: "default" | "compact"
  selected?: boolean
}

/** 渲染一行；行元素上的属性（onClick、role、aria-*、data-*、style、className）原样传给行元素。 */
export function ListRow({
  render,
  leading,
  title,
  titleProps,
  description,
  meta,
  actions,
  button,
  density = "default",
  selected = false,
  className,
  ...props
}: ListRowProps) {
  const titleNode = (
    <span {...titleProps} className={cn("list-row-title", titleProps?.className)}>
      {title}
    </span>
  )
  const text = description ? (
    <span className="list-row-text">
      {titleNode}
      <span className="list-row-desc">{description}</span>
    </span>
  ) : (
    titleNode
  )
  return useRender({
    render,
    defaultTagName: "div",
    props: {
      ...props,
      className: cn("list-row", className),
      "data-density": density === "compact" ? "compact" : undefined,
      "data-selected": selected ? "" : undefined,
      "data-interactive": props.onClick || button ? "" : undefined,
      children: (
        <>
          {leading ? <span className="list-row-leading">{leading}</span> : null}
          {button ? (
            <button type="button" {...button} className={cn("list-row-button", button.className)}>
              {text}
            </button>
          ) : (
            text
          )}
          {meta ? <span className="list-row-meta">{meta}</span> : null}
          {actions ? <span className="list-row-actions">{actions}</span> : null}
        </>
      ),
    },
  })
}
