/** 响应式视图的设备栏：设备预设、视口宽高、横竖切换，页面区放不下时显示缩放比例。 */
import { useEffect, useState } from "react"
import { Check, ChevronDown, RotateCcw } from "lucide-react"
import { Button, Select, useLocale, type MessageKey } from "@pigcode/ui-primitives"
import {
  DEVICE_PRESETS,
  VIEWPORT_MAX,
  VIEWPORT_MIN,
  type BrowserViewport,
  type DevicePreset,
} from "./browser-viewport"

const PRESET_KEYS: Record<string, MessageKey> = {
  laptop: "browser.device.laptop",
  desktop: "browser.device.desktop",
}

/** 宽或高的输入框：回车或离开时生效，超出范围时收回到边界。 */
function SizeInput({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const commit = () => {
    const parsed = Math.round(Number(text))
    if (!Number.isFinite(parsed) || text.trim() === "") {
      setText(String(value))
      return
    }
    const clamped = Math.min(VIEWPORT_MAX, Math.max(VIEWPORT_MIN, parsed))
    setText(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <input
      className="browser-device-input"
      type="number"
      inputMode="numeric"
      min={VIEWPORT_MIN}
      max={VIEWPORT_MAX}
      aria-label={label}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit()
      }}
    />
  )
}

export function BrowserDeviceBar({
  viewport,
  scale,
  onChange,
}: {
  viewport: BrowserViewport
  scale: number
  onChange: (viewport: BrowserViewport) => void
}) {
  const { t } = useLocale()
  const nameOf = (preset: DevicePreset) =>
    preset.name ?? t(PRESET_KEYS[preset.id] ?? "browser.responsive.custom")
  const current = DEVICE_PRESETS.find((preset) => preset.id === viewport.device)
  return (
    <div className="browser-device-bar">
      <Select.Root
        value={viewport.device}
        onValueChange={(id) => {
          const preset = DEVICE_PRESETS.find((item) => item.id === id)
          if (preset) onChange({ device: preset.id, width: preset.width, height: preset.height })
        }}
      >
        <Select.Trigger className="pill-select" aria-label={t("browser.responsive.device")}>
          <Select.Value>
            {() => (current ? nameOf(current) : t("browser.responsive.custom"))}
          </Select.Value>
          <ChevronDown className="ic ic-sm" aria-hidden="true" />
        </Select.Trigger>
        <Select.Portal>
          <Select.Positioner sideOffset={6} align="start" alignItemWithTrigger={false}>
            <Select.Popup className="choice-popup browser-device-popup">
              {DEVICE_PRESETS.map((preset) => (
                <Select.Item key={preset.id} value={preset.id}>
                  <Select.ItemText>{nameOf(preset)}</Select.ItemText>
                  <span className="menu-meta">
                    {preset.width}×{preset.height}
                  </span>
                  <Select.ItemIndicator className="check-mark">
                    <Check className="ic ic-sm" aria-hidden="true" />
                  </Select.ItemIndicator>
                </Select.Item>
              ))}
              {current ? null : (
                <Select.Item value="custom" disabled>
                  <Select.ItemText>{t("browser.responsive.custom")}</Select.ItemText>
                </Select.Item>
              )}
            </Select.Popup>
          </Select.Positioner>
        </Select.Portal>
      </Select.Root>
      <span className="browser-device-size">
        <SizeInput
          label={t("browser.responsive.width")}
          value={viewport.width}
          onCommit={(width) => onChange({ device: "custom", width, height: viewport.height })}
        />
        <span className="browser-device-times" aria-hidden="true">
          ×
        </span>
        <SizeInput
          label={t("browser.responsive.height")}
          value={viewport.height}
          onCommit={(height) => onChange({ device: "custom", width: viewport.width, height })}
        />
      </span>
      <Button
        variant="plain"
        size="icon"
        type="button"
        aria-label={t("browser.responsive.rotate")}
        title={t("browser.responsive.rotate")}
        onClick={() =>
          onChange({ device: viewport.device, width: viewport.height, height: viewport.width })
        }
      >
        <RotateCcw className="ic ic-sm" aria-hidden="true" />
      </Button>
      {scale < 1 ? (
        <span className="browser-device-scale">
          {t("browser.responsive.scale").replace("{percent}", String(Math.round(scale * 100)))}
        </span>
      ) : null}
    </div>
  )
}
