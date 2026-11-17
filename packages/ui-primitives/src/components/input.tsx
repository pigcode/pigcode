/** 基于 Base UI Input 的文本输入。 */
import { Input as BaseInput } from "@base-ui/react/input"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export type InputProps = Omit<ComponentProps<typeof BaseInput>, "size"> & {
  /** 字符串选择控件高度，数字仍传给原生 input 的 size。 */
  size?: "xs" | "sm" | "md" | "lg" | "xl" | number | undefined
}

export function Input({ className, size, ...props }: InputProps) {
  return (
    <BaseInput
      className={cn("input", className)}
      data-size={typeof size === "string" ? size : undefined}
      size={typeof size === "number" ? size : undefined}
      {...props}
    />
  )
}
