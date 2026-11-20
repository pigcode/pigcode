import { useEffect, useId, useRef } from "react"
import { Button, useLocale } from "@pigcode/ui-primitives"
export function AccentField({
  color,
  disabled = false,
  onChange,
}: {
  disabled?: boolean
  color?: string | undefined
  onChange: (value: string | undefined) => void
}) {
  const { t } = useLocale()
  const id = useId()
  const swatch = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!swatch.current) return
    const fallback = getComputedStyle(swatch.current)
      .getPropertyValue("--instance-accent-default")
      .trim()
    if (color || fallback) swatch.current.value = color || fallback
  }, [color])
  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {t("agents.instance.color")}
      </label>
      <div className="agent-accent-control">
        <input
          id={id}
          type="color"
          disabled={disabled}
          defaultValue={color}
          ref={swatch}
          onChange={(e) => onChange(e.target.value)}
        />
        {color && (
          <>
            <code>{color}</code>
            <Button
              disabled={disabled}
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => onChange(undefined)}
            >
              {t("agents.instance.clearColor")}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
