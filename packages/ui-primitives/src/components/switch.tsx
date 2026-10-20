/** 基于 Base UI Switch 的开关。 */
import { Switch as BaseSwitch } from "@base-ui/react/switch"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function Switch({ className, ...props }: ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root className={cn("switch", className)} {...props}>
      <BaseSwitch.Thumb className="switch-thumb" />
    </BaseSwitch.Root>
  )
}
