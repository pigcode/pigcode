/** 基于 Base UI Checkbox 的复选框。 */
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function CheckboxRoot({ className, ...props }: ComponentProps<typeof BaseCheckbox.Root>) {
  return <BaseCheckbox.Root className={cn("checkbox", className)} {...props} />
}

export function CheckboxIndicator({
  className,
  ...props
}: ComponentProps<typeof BaseCheckbox.Indicator>) {
  return <BaseCheckbox.Indicator className={cn("checkbox-indicator", className)} {...props} />
}

export const Checkbox = {
  Root: CheckboxRoot,
  Indicator: CheckboxIndicator,
}
