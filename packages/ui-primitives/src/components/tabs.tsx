/**
 * 标签页：一排文字标签，选中的下面有一条滑动的指示线，内容区跟着切换。
 * 基于 Base UI Tabs，读屏读作 tablist，方向键在标签间移动。样式在 controls.css。
 */
import { Tabs as BaseTabs } from "@base-ui/react/tabs"
import type { ComponentProps } from "react"
import { withBaseClass } from "./base-class"

function Root({ className, ...props }: ComponentProps<typeof BaseTabs.Root>) {
  return <BaseTabs.Root className={withBaseClass("tabs", className)} {...props} />
}

/** 标签行；指示线自动放在最后，跟着选中的标签滑动。 */
function List({ className, children, ...props }: ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List className={withBaseClass("tabs-list", className)} {...props}>
      {children}
      <BaseTabs.Indicator className="tabs-indicator" />
    </BaseTabs.List>
  )
}

function Tab({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) {
  return <BaseTabs.Tab className={withBaseClass("tabs-tab", className)} {...props} />
}

function Panel({ className, ...props }: ComponentProps<typeof BaseTabs.Panel>) {
  return <BaseTabs.Panel className={withBaseClass("tabs-panel", className)} {...props} />
}

export const Tabs = { Root, List, Tab, Panel }
