/**
 * 运行中指示：3×3 点阵里一组亮点沿固定路线游走，8 帧一个循环。
 * 动画全部由 CSS 完成，不触发 React 重渲染；减少动效时停在一帧上。
 */
import type { HTMLAttributes } from "react"
import { cn } from "./cn"

const CELLS = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const

/** 点阵指示器的属性；label 提供给读屏，缺省时只作装饰。 */
export interface DotMatrixProps extends HTMLAttributes<HTMLSpanElement> {
  label?: string
}

/** 画出 3×3 点阵；颜色继承 currentColor。 */
export function DotMatrix({ label, className, ...props }: DotMatrixProps) {
  return (
    <span
      className={cn("dot-matrix", className)}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
      {...props}
    >
      {CELLS.map((cell) => (
        <i key={cell} className={`dot-matrix-cell c${cell}`} />
      ))}
    </span>
  )
}
