// 外观页的主题小窗：用一个主题的颜色画一个缩小的 Pigcode 窗口（侧栏、对话、diff、输入框）。
// 同一个小窗用在三处：模式缩略图、主题大预览和主题列表，尺寸全部按小窗自身宽度缩放（见 appearance.css）。
import type { CSSProperties, KeyboardEvent } from "react"
import { ArrowUp, Check, X } from "lucide-react"
import {
  activeSlot,
  builtInThemes,
  cn,
  previewPalette,
  themeSwatch,
  useLocale,
  type AppearanceController,
  type ColorKey,
  type Hex,
  type ThemePreference,
} from "@pigcode/ui-primitives"
import { fill } from "./schedule-format"

type Mode = "light" | "dark"

/**
 * 单选组的方向键：左右（上下）移到上一个、下一个，Home/End 到两头，边走边选中；
 * 组里只有选中的那一项在 Tab 顺序里（tabIndex 由调用方按 checked 设）。
 */
function onRadioKey(event: KeyboardEvent<HTMLButtonElement>, select: (index: number) => void) {
  const group = event.currentTarget.closest('[role="radiogroup"]')
  if (!group) return
  const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  const index = radios.indexOf(event.currentTarget)
  const last = radios.length - 1
  const next =
    event.key === "ArrowRight" || event.key === "ArrowDown"
      ? index === last
        ? 0
        : index + 1
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? index === 0
          ? last
          : index - 1
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : null
  if (next === null || index < 0) return
  event.preventDefault()
  radios[next]?.focus()
  select(next)
}

/** 一条文字占位：宽度是所在行的百分比。 */
function Bar({
  width,
  tone,
}: {
  width: number
  tone?: "fg" | "muted" | "accent" | "add" | "remove"
}) {
  return <b className={cn("mini-bar", tone && `is-${tone}`)} style={{ width: `${width}%` }} />
}

/** 缩小的 Pigcode 窗口。detail 时画出 diff 符号和发送图标，缩略图里省掉。 */
export function MiniWindow({
  colors,
  detail = false,
  className,
}: {
  colors: Record<ColorKey, Hex>
  detail?: boolean
  className?: string | undefined
}) {
  return (
    <div className={cn("mini-frame", className)}>
      <div className="mini" style={previewPalette(colors) as CSSProperties} aria-hidden="true">
        <div className="mini-side">
          <span className="mini-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="mini-row is-active">
            <Bar width={72} tone="fg" />
          </span>
          <span className="mini-row">
            <Bar width={54} />
          </span>
          <span className="mini-row">
            <Bar width={63} />
          </span>
          <span className="mini-row">
            <Bar width={46} />
          </span>
        </div>
        <div className="mini-main">
          <span className="mini-bubble">
            <Bar width={100} tone="fg" />
          </span>
          <span className="mini-text">
            <Bar width={92} tone="fg" />
            <Bar width={78} tone="fg" />
            <Bar width={34} tone="accent" />
          </span>
          <span className="mini-diff">
            <span className="is-add">
              {detail ? <i>+</i> : null}
              <Bar width={58} tone="add" />
            </span>
            <span className="is-remove">
              {detail ? <i>−</i> : null}
              <Bar width={44} tone="remove" />
            </span>
            <span className="is-add">
              {detail ? <i>+</i> : null}
              <Bar width={67} tone="add" />
            </span>
          </span>
          <span className="mini-composer">
            <Bar width={38} />
            <span className="mini-send">{detail ? <ArrowUp aria-hidden="true" /> : null}</span>
          </span>
        </div>
      </div>
    </div>
  )
}

/** 当前某个模式实际使用的主题颜色。 */
function slotColors(appearance: AppearanceController, mode: Mode): Record<ColorKey, Hex> {
  const { settings, customThemes } = appearance
  return themeSwatch(settings, customThemes, mode, activeSlot(settings, mode).themeId)
}

/** 模式选择：三个窗口缩略图，跟随系统是一扇斜着分成浅、深两半的窗口。 */
export function ModePicker({
  appearance,
  onPick,
}: {
  appearance: AppearanceController
  onPick: (mode: ThemePreference) => void
}) {
  const { t } = useLocale()
  const light = slotColors(appearance, "light")
  const dark = slotColors(appearance, "dark")
  const options: { value: ThemePreference; label: string }[] = [
    { value: "system", label: t("settings.appearance.system") },
    { value: "light", label: t("settings.appearance.light") },
    { value: "dark", label: t("settings.appearance.dark") },
  ]
  return (
    <div className="mode-picker" role="radiogroup" aria-label={t("settings.appearance.mode")}>
      {options.map((option) => {
        const checked = appearance.settings.mode === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            className="mode-card"
            data-checked={checked || undefined}
            tabIndex={checked ? 0 : -1}
            onClick={() => onPick(option.value)}
            onKeyDown={(event) =>
              onRadioKey(event, (index) => {
                const target = options[index]
                if (target) onPick(target.value)
              })
            }
          >
            <span className="mode-thumb">
              {option.value === "dark" ? (
                <MiniWindow colors={dark} />
              ) : (
                <MiniWindow colors={light} />
              )}
              {option.value === "system" ? (
                <MiniWindow colors={dark} className="mode-thumb-dark" />
              ) : null}
            </span>
            <span className="mode-label">{option.label}</span>
          </button>
        )
      })}
    </div>
  )
}

/** 主题列表：每个主题一扇小窗，选中的带强调色描边和对勾。 */
export function ThemeGallery({
  appearance,
  mode,
  onPick,
  onRemove,
}: {
  appearance: AppearanceController
  mode: Mode
  onPick: (themeId: string) => void
  /** 删除「我的主题」里的一套；内置主题没有删除按钮。 */
  onRemove: (themeId: string) => void
}) {
  const { t } = useLocale()
  const { settings, customThemes } = appearance
  const current = activeSlot(settings, mode).themeId
  const themes = [...builtInThemes, ...customThemes]
  const selected = themes.some((theme) => theme.id === current) ? current : builtInThemes[0].id
  return (
    <div className="theme-gallery" role="radiogroup" aria-label={t("settings.appearance.theme")}>
      {themes.map((theme) => {
        const checked = theme.id === selected
        const name = theme.builtIn
          ? theme.name
          : fill(t("settings.appearance.theme.custom"), { name: theme.name })
        const remove = fill(t("settings.appearance.removeTheme"), { name: theme.name })
        return (
          <div key={theme.id} className="theme-tile-wrap">
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={name}
              className="theme-tile"
              data-checked={checked || undefined}
              tabIndex={checked ? 0 : -1}
              onClick={() => onPick(theme.id)}
              onKeyDown={(event) =>
                onRadioKey(event, (index) => {
                  const target = themes[index]
                  if (target) onPick(target.id)
                })
              }
            >
              <MiniWindow colors={themeSwatch(settings, customThemes, mode, theme.id)} />
              <span className="theme-tile-name">
                <span className="truncate">{name}</span>
                {checked ? <Check className="ic ic-sm" aria-hidden="true" /> : null}
              </span>
            </button>
            {theme.builtIn ? null : (
              <button
                type="button"
                className="theme-tile-remove"
                aria-label={remove}
                title={remove}
                onClick={() => onRemove(theme.id)}
              >
                <X aria-hidden="true" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
