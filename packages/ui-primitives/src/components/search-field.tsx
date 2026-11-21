/**
 * 搜索框：放大镜、输入框、有内容时可选的清除按钮，以及右侧的补充元素（比如命令面板的 esc）。
 * 文件树用 compact，弹层用 lg，页面搜索用 xl。命令面板与模型菜单用 plain 外观。
 * 插件页的搜索用 lg 加 pill 形状（Cursor 插件页的 InputGroup shape="pill"）。
 */
import { Search, X } from "lucide-react"
import type { ComponentProps, ReactNode, Ref } from "react"
import { cn } from "./cn"

export type SearchFieldProps = Omit<
  ComponentProps<"input">,
  "value" | "onChange" | "size" | "type" | "ref" | "children"
> & {
  value: string
  onValueChange: (value: string) => void
  size?: "default" | "compact" | "lg" | "xl"
  variant?: "default" | "plain" | undefined
  /** pill：两头全圆。 */
  shape?: "default" | "pill" | undefined
  /** 输入框本身的 ref，用来设置初始焦点。 */
  inputRef?: Ref<HTMLInputElement> | undefined
  /** 清除按钮的无障碍名称；给了它，有内容时右侧才出现清除按钮。 */
  clearLabel?: string | undefined
  /** 放在最右侧的元素，比如快捷键提示。 */
  trailing?: ReactNode | undefined
}

/** 渲染搜索框；无障碍名称默认等于 placeholder，其余输入框属性原样传给 input。 */
export function SearchField({
  value,
  onValueChange,
  size = "default",
  variant = "default",
  shape = "default",
  inputRef,
  clearLabel,
  trailing,
  className,
  placeholder,
  "aria-label": ariaLabel,
  ...props
}: SearchFieldProps) {
  return (
    <label
      className={cn("search-field", className)}
      data-size={size}
      data-variant={variant}
      data-shape={shape === "pill" ? "pill" : undefined}
    >
      <Search className="ic search-field-icon" aria-hidden="true" />
      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        {...props}
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        onChange={(event) => onValueChange(event.target.value)}
      />
      {clearLabel && value ? (
        <button
          type="button"
          className="search-field-clear"
          aria-label={clearLabel}
          title={clearLabel}
          onClick={(event) => {
            // 按钮清空后会消失，先把焦点交回输入框。
            event.currentTarget.parentElement?.querySelector("input")?.focus()
            onValueChange("")
          }}
        >
          <X className="ic" aria-hidden="true" />
        </button>
      ) : null}
      {trailing}
    </label>
  )
}
