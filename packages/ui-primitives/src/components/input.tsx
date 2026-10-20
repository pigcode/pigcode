/** 基于 Base UI Input 的文本输入。 */
import { Input as BaseInput } from "@base-ui/react/input"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function Input({ className, ...props }: ComponentProps<typeof BaseInput>) {
  return <BaseInput className={cn("input", className)} {...props} />
}
