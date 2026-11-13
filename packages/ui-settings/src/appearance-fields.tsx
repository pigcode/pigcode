// 外观设置页用到的小控件：滑块、颜色色片和字体输入框。
import { useEffect, useRef, useState } from "react"
import { ChevronDown, X } from "lucide-react"
import {
  Autocomplete,
  Input,
  Slider,
  fontDisplayName,
  fontFromDisplayName,
  parseHex,
  presetFontNames,
  useLocale,
  type ColorKey,
  type Hex,
  type MessageKey,
} from "@pigcode/ui-primitives"
import { fill } from "./schedule-format"

/** 滑块与右侧数值。 */
export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean | undefined
  onChange: (value: number) => void
}) {
  return (
    <div className="appearance-slider">
      <Slider.Root
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={[value]}
        onValueChange={(next) => {
          const first = typeof next === "number" ? next : next[0]
          if (first !== undefined) onChange(first)
        }}
      >
        <Slider.Control>
          <Slider.Track>
            <Slider.Indicator />
            <Slider.Thumb aria-label={label} />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <span className="num">{value}</span>
    </div>
  )
}

const colorLabels: Record<ColorKey, MessageKey> = {
  accent: "settings.appearance.color.accent",
  bg: "settings.appearance.color.bg",
  fg: "settings.appearance.color.fg",
  diffAdded: "settings.appearance.color.diffAdded",
  diffRemoved: "settings.appearance.color.diffRemoved",
}

/**
 * 一个颜色色片：圆形色块（点开是系统取色器）、名字和可以直接改的十六进制值。
 * 只在输入合法的 `#RRGGBB` 时提交；改过的颜色在名字旁边有恢复按钮。
 */
function ColorChip({
  name,
  label,
  value,
  changed,
  onChange,
  onReset,
}: {
  name: string
  label: string
  value: Hex
  changed: boolean
  onChange: (value: Hex) => void
  onReset: () => void
}) {
  const { t } = useLocale()
  const [text, setText] = useState<string>(value)
  useEffect(() => setText(value), [value])
  const commit = (raw: string) => {
    const next = parseHex(raw.startsWith("#") ? raw : `#${raw}`)
    if (next) onChange(next)
  }
  return (
    <div className="color-chip" data-changed={changed || undefined}>
      <span className="color-chip-swatch" style={{ background: value }}>
        <input
          type="color"
          aria-label={label}
          value={value.toLowerCase()}
          onChange={(event) => commit(event.currentTarget.value)}
        />
      </span>
      <span className="color-chip-name">
        {name}
        {changed ? (
          <button
            type="button"
            className="color-chip-reset"
            aria-label={fill(t("settings.appearance.color.reset"), { color: label })}
            title={fill(t("settings.appearance.color.reset"), { color: label })}
            onClick={onReset}
          >
            <X aria-hidden="true" />
          </button>
        ) : null}
      </span>
      <Input
        className="color-chip-hex"
        aria-label={fill(t("settings.appearance.color.hex"), { color: label })}
        value={text}
        spellCheck={false}
        onChange={(event) => {
          setText(event.currentTarget.value)
          commit(event.currentTarget.value.trim())
        }}
        onBlur={() => setText(value)}
      />
    </div>
  )
}

/** 五种颜色排成一行色片。prefix 加在无障碍名字前面，区分浅色和深色。 */
export function ColorChips({
  prefix,
  colors,
  changed,
  keys,
  onChange,
}: {
  prefix: string
  colors: Record<ColorKey, Hex>
  changed: Record<ColorKey, boolean>
  keys: readonly ColorKey[]
  onChange: (key: ColorKey, value: Hex | null) => void
}) {
  const { t } = useLocale()
  return (
    <div className="color-chips">
      {keys.map((key) => (
        <ColorChip
          key={key}
          name={t(colorLabels[key])}
          label={`${prefix} · ${t(colorLabels[key])}`}
          value={colors[key]}
          changed={changed[key]}
          onChange={(value) => onChange(key, value)}
          onReset={() => onChange(key, null)}
        />
      ))}
    </div>
  )
}

/** 选择预设字体，或输入本机字体名后按回车或移开焦点。 */
export function FontField({
  kind,
  label,
  value,
  onChange,
}: {
  kind: "ui" | "code"
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const { t } = useLocale()
  const system = t("settings.appearance.font.system")
  const shown = fontDisplayName(kind, value)
  const options = [system, ...presetFontNames(kind)]
  const [text, setText] = useState(shown)
  const actions = useRef<{ close: () => void; unmount: () => void }>(null)
  useEffect(() => setText(shown), [shown])
  function commit(name: string): void {
    const next = fontFromDisplayName(kind, name === system ? "" : name)
    if (next !== value) onChange(next)
    setText(fontDisplayName(kind, next))
  }
  return (
    <Autocomplete.Root
      actionsRef={actions}
      items={options}
      filter={(option, query) =>
        query === shown || option.toLowerCase().includes(query.toLowerCase())
      }
      value={text}
      openOnInputClick
      onValueChange={(next, details) => {
        if (details.reason === "item-press") commit(next)
        else if (details.reason === "input-change") setText(next)
      }}
      onOpenChange={(open, details) => {
        if (!open && details.reason === "escape-key") setText(shown)
      }}
    >
      <Autocomplete.InputGroup className="font-field">
        <Autocomplete.Input
          aria-label={label}
          placeholder={system}
          spellCheck={false}
          onBlur={(event) => commit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              event.currentTarget.getAttribute("aria-activedescendant")
            )
              return
            event.preventDefault()
            commit(text)
            actions.current?.close()
          }}
        />
        <Autocomplete.Trigger
          className="font-field-trigger"
          aria-label={fill(t("settings.appearance.font.showPresets"), { field: label })}
        >
          <ChevronDown className="ic ic-sm" aria-hidden="true" />
        </Autocomplete.Trigger>
      </Autocomplete.InputGroup>
      <Autocomplete.Portal>
        <Autocomplete.Positioner sideOffset={4} align="end">
          <Autocomplete.Popup className="font-field-popup">
            <Autocomplete.List>
              {(option: string) => (
                <Autocomplete.Item key={option} value={option}>
                  {option}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  )
}
