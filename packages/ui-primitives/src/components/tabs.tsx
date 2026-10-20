/** 基于 Base UI Tabs 的分页切换组合。 */
import { Tabs as BaseTabs } from "@base-ui/react/tabs"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function TabsRoot({ className, ...props }: ComponentProps<typeof BaseTabs.Root>) {
  return <BaseTabs.Root className={cn("tabs", className)} {...props} />
}

export function TabsList({ className, ...props }: ComponentProps<typeof BaseTabs.List>) {
  return <BaseTabs.List className={cn("tabs-list", className)} {...props} />
}

export function TabsTab({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) {
  return <BaseTabs.Tab className={cn("tabs-tab", className)} {...props} />
}

export function TabsPanel({ className, ...props }: ComponentProps<typeof BaseTabs.Panel>) {
  return <BaseTabs.Panel className={cn("tabs-panel", className)} {...props} />
}

export const Tabs = {
  Root: TabsRoot,
  List: TabsList,
  Tab: TabsTab,
  Panel: TabsPanel,
}
