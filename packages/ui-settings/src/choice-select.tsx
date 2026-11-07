/**
 * 定时任务表单的下拉：field 是输入框样子（会话选择），pill 是计划框里的小胶囊（频率、几点、几分）。
 * 多选的星期几是一个胶囊，点开是带勾选的列表。
 */
import { Check, ChevronDown } from "lucide-react"
import { Popover, Select, cn } from "@pigcode/ui-primitives"

export function ChoiceSelect<T extends string>({
  label,
  value,
  options,
  variant = "field",
  disabled,
  className,
  onChange,
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  variant?: "field" | "pill"
  disabled?: boolean | undefined
  className?: string | undefined
  onChange: (value: T) => void
}) {
  return (
    <Select.Root
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next === "string") onChange(next as T)
      }}
    >
      <Select.Trigger
        className={cn(variant === "pill" ? "pill-select" : "input select-trigger", className)}
        aria-label={label}
      >
        <Select.Value className={variant === "pill" ? undefined : "grow truncate"}>
          {(current: string) =>
            options.find((option) => option.value === current)?.label ?? current
          }
        </Select.Value>
        <ChevronDown className="ic ic-sm" aria-hidden="true" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} align="start" alignItemWithTrigger={false}>
          <Select.Popup className="choice-popup">
            {options.map((option) => (
              <Select.Item key={option.value} value={option.value}>
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator className="check-mark">
                  <Check className="ic ic-sm" aria-hidden="true" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

/** 胶囊样子的多选：触发器显示选中的摘要，点开是带勾选的列表，选完不关闭。 */
export function MultiPill({
  label,
  summary,
  options,
  selected,
  disabled,
  onToggle,
}: {
  label: string
  summary: string
  options: ReadonlyArray<{ value: number; label: string }>
  selected: ReadonlySet<number>
  disabled?: boolean | undefined
  onToggle: (value: number) => void
}) {
  return (
    <Popover.Root>
      <Popover.Trigger className="pill-select" aria-label={label} disabled={disabled}>
        <span className="truncate">{summary}</span>
        <ChevronDown className="ic ic-sm" aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="start">
          <Popover.Popup className="menu-popup choice-popup" aria-label={label}>
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className="menu-item"
                role="menuitemcheckbox"
                aria-checked={selected.has(option.value)}
                onClick={() => onToggle(option.value)}
              >
                {option.label}
                {selected.has(option.value) ? (
                  <Check className="ic ic-sm check-mark" aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** 一排可以多选的小方块，例如每月的几号。 */
export function TogglePills({
  label,
  options,
  selected,
  disabled,
  className,
  onToggle,
}: {
  label: string
  options: ReadonlyArray<{ value: number; label: string; name?: string }>
  selected: ReadonlySet<number>
  disabled?: boolean | undefined
  className?: string | undefined
  onToggle: (value: number) => void
}) {
  return (
    <div className={cn("toggle-pills", className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="toggle-pill"
          aria-pressed={selected.has(option.value)}
          aria-label={option.name}
          disabled={disabled}
          onClick={() => onToggle(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
