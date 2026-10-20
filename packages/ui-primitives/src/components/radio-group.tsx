/** 基于 Base UI RadioGroup 与 Radio 的单选组合。 */
import { RadioGroup as BaseRadioGroup, type RadioGroupProps } from "@base-ui/react/radio-group"
import { Radio as BaseRadio, type RadioRootProps } from "@base-ui/react/radio"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function RadioGroupRoot<Value>({ className, ...props }: RadioGroupProps<Value>) {
  return <BaseRadioGroup className={cn("radio-group", className)} {...props} />
}

export function RadioRoot<Value>({ className, ...props }: RadioRootProps<Value>) {
  return <BaseRadio.Root className={cn("radio", className)} {...props} />
}

export function RadioIndicator({
  className,
  ...props
}: ComponentProps<typeof BaseRadio.Indicator>) {
  return <BaseRadio.Indicator className={cn("radio-dot", className)} {...props} />
}

export const RadioGroup = { Root: RadioGroupRoot }

export const Radio = {
  Root: RadioRoot,
  Indicator: RadioIndicator,
}
