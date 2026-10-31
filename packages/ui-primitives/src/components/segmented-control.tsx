/**
 * 分段控件：几个互斥的选项排成一条，选中的一段浮起。外观、思考深度等单选都用它；
 * 基于 Base UI RadioGroup，读屏读作单选组，方向键在选项间移动并选中。样式在 controls.css。
 */
import { RadioGroup as BaseRadioGroup } from "@base-ui/react/radio-group"
import { Radio as BaseRadio } from "@base-ui/react/radio"
import type { ReactNode } from "react"
import { cn } from "./cn"

/** 一个选项。 */
export interface SegmentedOption<Value extends string> {
  value: Value
  label: ReactNode
}

export interface SegmentedControlProps<Value extends string> {
  options: readonly SegmentedOption<Value>[]
  /** 当前选中的值；null 表示都没选中。 */
  value: Value | null
  onValueChange: (value: Value) => void
  /** 单选组的名字；读屏用。 */
  "aria-label": string
  disabled?: boolean | undefined
  className?: string | undefined
}

/** 渲染分段控件。 */
export function SegmentedControl<Value extends string>({
  options,
  value,
  onValueChange,
  "aria-label": label,
  disabled,
  className,
}: SegmentedControlProps<Value>) {
  return (
    <BaseRadioGroup<Value | null>
      className={cn("seg", className)}
      aria-label={label}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next)
      }}
    >
      {options.map((option) => (
        <BaseRadio.Root key={option.value} value={option.value} className="seg-item">
          {option.label}
        </BaseRadio.Root>
      ))}
    </BaseRadioGroup>
  )
}
