/**
 * 空状态：图标、标题、可选的一句说明和操作。页面与 Surface 用 default（居中，图标放在圆底里），
 * 列表与弹层用 compact（和列表行一样高的一行弱化文字）。加载中也用它，图标换成转圈的 Loader2。
 * 样式在 empty-states.css。
 */
import type { ComponentProps, ReactNode } from "react"
import { cn } from "./cn"

export type EmptyStateProps = Omit<ComponentProps<"div">, "title" | "children"> & {
  /** 图标；default 放在圆底里，compact 是标题前面的小图标。 */
  icon?: ReactNode | undefined
  title: ReactNode
  /** 标题下面的一句说明：这里会出现什么，或者下一步可以做什么。 */
  description?: ReactNode | undefined
  /** 下一步的按钮。 */
  actions?: ReactNode | undefined
  size?: "default" | "compact"
}

/** 渲染空状态；容器上的属性（className、role、aria-*、data-*）原样传给外层 div。 */
export function EmptyState({
  icon,
  title,
  description,
  actions,
  size = "default",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      {...props}
      className={cn("empty-state", className)}
      data-size={size === "compact" ? "compact" : undefined}
    >
      {icon ? (
        <span className="empty-state-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="empty-state-title">{title}</p>
      {description ? <p className="empty-state-desc">{description}</p> : null}
      {actions ? <div className="empty-state-actions">{actions}</div> : null}
    </div>
  )
}
