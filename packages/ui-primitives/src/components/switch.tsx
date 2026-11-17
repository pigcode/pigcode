/** 基于 Base UI Switch 的开关。 */
import { Switch as BaseSwitch } from "@base-ui/react/switch"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export type SwitchProps = ComponentProps<typeof BaseSwitch.Root> & { size?: "md" | "sm" }

export function Switch({ className, size = "md", ...props }: SwitchProps) {
  return (
    <BaseSwitch.Root className={cn("switch", className)} data-size={size} {...props}>
      <BaseSwitch.Thumb className="switch-thumb" />
    </BaseSwitch.Root>
  )
}
