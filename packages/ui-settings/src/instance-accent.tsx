import type { ClaudeIdlePolicy } from "@pigcode/contracts"
import { useEffect, useId, useRef, useState } from "react"
import { Button, useLocale } from "@pigcode/ui-primitives"
export function AccentField({
  color,
  onChange,
}: {
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
          defaultValue={color}
          ref={swatch}
          onChange={(e) => onChange(e.target.value)}
        />
        {color && (
          <>
            <code>{color}</code>
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(undefined)}>
              {t("agents.instance.clearColor")}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

export function ClaudeIdleDefault({
  value,
  onChange,
}: {
  value: ClaudeIdlePolicy
  onChange: (mode: ClaudeIdlePolicy) => Promise<void>
}) {
  const { t } = useLocale()
  const [error, setError] = useState("")
  const [saving, setSaving] = useState(false)
  return (
    <details className="agent-advanced-default">
      <summary>{t("agents.advanced")}</summary>
      <label className="agent-field-label">
        {t("agents.claude.idleDefault")}
        <select
          className="input"
          disabled={saving}
          value={value}
          onChange={async (e) => {
            setSaving(true)
            setError("")
            try {
              await onChange(e.target.value as ClaudeIdlePolicy)
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause))
            } finally {
              setSaving(false)
            }
          }}
        >
          <option value="onReturn">{t("agents.claude.onReturn")}</option>
          <option value="beforeCacheExpires">{t("agents.claude.beforeExpires")}</option>
          <option value="off">{t("agents.claude.never")}</option>
        </select>
      </label>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </details>
  )
}
