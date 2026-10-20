/** 基于 Base UI ToggleGroup 与 Toggle 的分段切换。 */
import { ToggleGroup as BaseToggleGroup, type ToggleGroupProps } from "@base-ui/react/toggle-group"
import { Toggle as BaseToggle, type ToggleProps } from "@base-ui/react/toggle"
import { cn } from "./cn"

export function ToggleGroup<Value extends string>({
  className,
  ...props
}: ToggleGroupProps<Value>) {
  return <BaseToggleGroup className={cn("seg", className)} {...props} />
}

export function Toggle<Value extends string>({ className, ...props }: ToggleProps<Value>) {
  return <BaseToggle className={cn("seg-item", className)} {...props} />
}
