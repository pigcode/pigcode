// 设置类页面的通用外框（设置、Agent、插件管理共用）：标题栏、内容列、分组与设置行。
import type { ReactNode } from "react"
import { cn } from "./cn"
import { ListRow } from "./list-row"

/** 设置页容器：标题加居中内容列。所有设置页共用一个版心，内容区变窄时跟着收缩。 */
export function SettingPage({
  title,
  sub,
  actions,
  className,
  children,
}: {
  title: string
  sub?: string | undefined
  actions?: ReactNode | undefined
  /** 页面自己的类名，用来写这一页特有的布局。 */
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <div className={cn("page", "settings-page", className)}>
      <header className="page-head">
        <div>
          <h1>{title}</h1>
          {sub ? <p className="sub">{sub}</p> : null}
        </div>
        {actions ? <div className="actions">{actions}</div> : null}
      </header>
      {children}
    </div>
  )
}

/**
 * 设置分组；不给标题时作为页面的第一组直接显示。actions 放在分组标题右边；
 * plain 时内容直接放在页面上，不套分组卡片（内容自己画卡片或不需要卡片时用）。
 */
export function SettingSection({
  title,
  actions,
  plain = false,
  children,
}: {
  title?: string | undefined
  actions?: ReactNode | undefined
  plain?: boolean | undefined
  children: ReactNode
}) {
  return (
    <section className="section">
      {title ? (
        <div className="section-head">
          <h2>{title}</h2>
          {actions ? <div className="section-actions">{actions}</div> : null}
        </div>
      ) : null}
      {plain ? children : <div className="group">{children}</div>}
    </section>
  )
}

/** 设置单行：左侧标题和说明，右侧是只读值或控件。 */
export function SettingRow({
  title,
  description,
  value,
  children,
}: {
  title: ReactNode
  description?: ReactNode | undefined
  value?: ReactNode | undefined
  children?: ReactNode | undefined
}) {
  return <ListRow title={title} description={description} meta={value} actions={children} />
}
