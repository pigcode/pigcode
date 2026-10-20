/** 基于 Base UI useRender 的按钮；样式沿用 pigclaude 的 btn 语义。 */
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import type { ComponentProps, ReactElement } from "react"
import { cn } from "./cn"

const buttonVariants = cva("btn", {
  variants: {
    variant: {
      primary: "btn-primary",
      secondary: "btn-secondary",
      ghost: "btn-ghost",
      danger: "btn-danger",
      solidDanger: "btn-solid-danger",
      plain: "",
    },
    size: {
      sm: "btn-sm",
      md: "",
      lg: "btn-lg",
      block: "btn-block btn-lg",
      icon: "btn-icon",
    },
  },
  defaultVariants: { variant: "secondary", size: "md" },
})

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** 替换默认的 button 元素，等价于 Radix asChild。 */
    render?: ReactElement
  }

/** 渲染按钮；render 存在时合并类名与事件。 */
export function Button({ className, variant, size, render, ...props }: ButtonProps) {
  return useRender({
    render,
    defaultTagName: "button",
    props: {
      ...props,
      className: cn(buttonVariants({ variant, size }), className),
    },
  })
}
