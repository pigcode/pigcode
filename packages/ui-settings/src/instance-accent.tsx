import { useEffect, useRef } from "react"
import { Check, Pipette, Plus } from "lucide-react"
import { Button, INSTANCE_ACCENT_PRESETS, Popover, useLocale } from "@pigcode/ui-primitives"

/** 一排预设色片加一个自定义取色器；再点一次已选的预设就清掉颜色。 */
export function AccentSwatches({
  color,
  disabled = false,
  onChange,
}: {
  color?: string | undefined
  disabled?: boolean
  onChange: (value: string | undefined) => void
}) {
  const { t } = useLocale()
  const swatch = useRef<HTMLInputElement>(null)
  const normalized = color?.toLowerCase()
  const isCustom = Boolean(
    normalized && !INSTANCE_ACCENT_PRESETS.some((preset) => preset.toLowerCase() === normalized),
  )

  useEffect(() => {
    if (!swatch.current) return
    const fallback = getComputedStyle(swatch.current)
      .getPropertyValue("--instance-accent-default")
      .trim()
    if (color || fallback) swatch.current.value = color || fallback
  }, [color])

  return (
    <div className="agent-accent-swatches">
      {INSTANCE_ACCENT_PRESETS.map((preset) => {
        const active = normalized === preset.toLowerCase()
        return (
          <button
            key={preset}
            type="button"
            className="agent-swatch"
            style={{ backgroundColor: preset }}
            aria-label={preset}
            aria-pressed={active}
            data-active={active || undefined}
            disabled={disabled}
            onClick={() => onChange(active ? undefined : preset)}
          >
            {active ? <Check className="ic ic-xs" aria-hidden="true" /> : null}
          </button>
        )
      })}
      <span
        className="agent-swatch agent-swatch-custom"
        data-active={isCustom || undefined}
        style={isCustom && color ? { backgroundColor: color } : undefined}
        title={t("agents.instance.accentCustom")}
      >
        <input
          type="color"
          aria-label={t("agents.instance.accentCustom")}
          disabled={disabled}
          defaultValue={color}
          ref={swatch}
          onChange={(e) => onChange(e.target.value)}
        />
        <Pipette className="ic ic-xs" aria-hidden="true" />
      </span>
    </div>
  )
}

/** 名字旁边的取色按钮：圆点是现在的颜色，没选时是一个加号；点开是色片和自定义取色。 */
export function AccentPicker({
  color,
  disabled = false,
  onChange,
}: {
  color?: string | undefined
  disabled?: boolean
  onChange: (value: string | undefined) => void
}) {
  const { t } = useLocale()
  return (
    <Popover.Root>
      <Popover.Trigger
        className="agent-accent-trigger"
        aria-label={t("agents.instance.color")}
        title={t("agents.instance.color")}
        disabled={disabled}
        data-empty={color ? undefined : ""}
        style={color ? { backgroundColor: color } : undefined}
      >
        {color ? null : <Plus className="ic ic-xs" aria-hidden="true" />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8}>
          <Popover.Popup className="agent-accent-popup">
            <div className="agent-accent-popup-head">
              <Popover.Title className="agent-accent-popup-title">
                {t("agents.instance.color")}
              </Popover.Title>
              {color ? (
                <Button size="xs" variant="ghost" type="button" onClick={() => onChange(undefined)}>
                  {t("agents.instance.clearColor")}
                </Button>
              ) : null}
            </div>
            <AccentSwatches color={color} disabled={disabled} onChange={onChange} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
