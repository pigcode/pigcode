import { useId, type ReactNode } from "react"
import { cn } from "@pigcode/ui-primitives"

/** 右栏里的一组设置：小标题（右边可以跟摘要和操作），下面几行，行与行之间一条通栏细线。 */
export function AgentSection({
  title,
  meta,
  actions,
  className,
  children,
}: {
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string | undefined
  children: ReactNode
}) {
  const id = useId()
  return (
    <section className={cn("agent-section", className)} aria-labelledby={id}>
      <div className="agent-section-head">
        <h4 id={id}>{title}</h4>
        {meta ? (
          <span className="agent-section-meta" aria-live="polite">
            {meta}
          </span>
        ) : null}
        {actions ? <div className="agent-section-actions">{actions}</div> : null}
      </div>
      <div className="agent-rows">{children}</div>
    </section>
  )
}

/** 一行里放不下的设置（参数列表、环境变量、登录操作）：名字和说明在上，内容整行铺开在下面。 */
export function AgentBlockRow({
  title,
  description,
  className,
  children,
}: {
  title?: ReactNode
  description?: ReactNode
  className?: string | undefined
  children?: ReactNode
}) {
  return (
    <div className={cn("agent-block-row", className)}>
      {title || description ? (
        <div className="agent-block-copy">
          {title ? <span className="agent-block-title">{title}</span> : null}
          {description ? <p className="agent-block-desc">{description}</p> : null}
        </div>
      ) : null}
      {children}
    </div>
  )
}
