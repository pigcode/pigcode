/**
 * 状态点：侧栏会话、子代理标签与页头、Agent 列表和插件列表都用它，同一种状态在哪里都是同一个颜色。
 * 运行中画游走的点阵（DotMatrix），其余状态是一个圆点。样式在 indicators.css。
 */
import type { ComponentProps } from "react"
import { cn } from "./cn"
import { DotMatrix } from "./dot-matrix"

/**
 * 状态色调：running 运行中（强调色点阵）、ready 就绪或已完成（绿）、warning 等待许可、排队或需要处理（黄）、
 * error 失败（红）、checking 检测中（蓝，闪烁）、idle 空闲、已停用或已中断（灰）。
 */
export type StatusTone = "running" | "ready" | "warning" | "error" | "checking" | "idle"

export type StatusDotProps = Omit<ComponentProps<"span">, "children"> & {
  tone: StatusTone
  /** 读屏读到的状态；缺省时只作装饰，状态由旁边的文字给出。 */
  label?: string | undefined
}

/** 渲染状态点；外层 span 上的属性（className、data-*）原样传入。 */
export function StatusDot({ tone, label, className, ...props }: StatusDotProps) {
  return (
    <span
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...props}
      className={cn("status-dot", className)}
      data-tone={tone}
    >
      {tone === "running" ? <DotMatrix /> : null}
    </span>
  )
}
