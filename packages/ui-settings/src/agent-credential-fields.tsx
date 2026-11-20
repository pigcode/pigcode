import { Lock, Plus, Unlock, X } from "lucide-react"
import { useId } from "react"
import { Button, Input, useLocale } from "@pigcode/ui-primitives"
import {
  secretReferenceSchema,
  type AgentSecretInput,
  type EnvironmentEntry,
} from "@pigcode/contracts"

export function CredentialField({
  label,
  value,
  references,
  onChange,
}: {
  label: string
  value: unknown
  references?: boolean | undefined
  onChange: (value: AgentSecretInput | string) => void
}) {
  const { t } = useLocale()
  const secret =
    value && typeof value === "object"
      ? (value as Partial<{ reference: string; configured: boolean; secret: string }>)
      : undefined
  const reference = secret?.reference
  const configured = secret?.configured === true
  return (
    <div className="agent-credential">
      {(references || reference !== undefined) && (
        <select
          className="input"
          aria-label={label + " · " + t("agents.secret.source")}
          value={reference !== undefined ? "op" : "stored"}
          onChange={(e) => onChange(e.currentTarget.value === "op" ? { reference: "" } : "")}
        >
          <option value="stored">{t("agents.secret.stored")}</option>
          <option value="op">1Password</option>
        </select>
      )}
      <div className="agent-input-row">
        <Input
          aria-label={label}
          className="mono"
          aria-invalid={
            reference !== undefined && !secretReferenceSchema.safeParse({ reference }).success
          }
          type={reference !== undefined ? "text" : "password"}
          autoComplete="new-password"
          spellCheck={false}
          value={reference ?? secret?.secret ?? (typeof value === "string" ? value : "")}
          placeholder={
            reference !== undefined
              ? "op://vault/item/field"
              : configured
                ? t("agents.secret.configured")
                : t("agents.secret.empty")
          }
          onChange={(e) =>
            onChange(
              reference !== undefined ? { reference: e.target.value } : { secret: e.target.value },
            )
          }
        />
        {(configured || reference || secret?.secret) && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("agents.secret.clear") + " " + label}
            onClick={() => onChange("")}
          >
            <X className="ic ic-sm" />
          </Button>
        )}
      </div>
    </div>
  )
}

export function EnvironmentEditor({
  label,
  entries,
  onChange,
  references,
}: {
  label: string
  entries: readonly EnvironmentEntry[]
  onChange: (entries: EnvironmentEntry[]) => void
  references?: boolean | undefined
}) {
  const { t } = useLocale()
  const errorId = useId()
  const update = (index: number, patch: Partial<EnvironmentEntry>) =>
    onChange(entries.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)))
  return (
    <div className="agent-env" role="group" aria-label={label}>
      {!entries.length && <p className="agent-muted">{t("agents.env.empty")}</p>}
      {entries.map((entry, index) => {
        const saved = typeof entry.value === "object" && "configured" in entry.value
        const referenced = typeof entry.value === "object" && "reference" in entry.value
        const valueLabel = t("agents.env.value") + " " + (index + 1)
        const invalidName = Boolean(entry.name && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name))
        return (
          <div className="agent-env-row" key={index}>
            <Input
              className="mono"
              aria-label={t("agents.env.name") + " " + (index + 1)}
              value={entry.name}
              disabled={saved}
              placeholder={t("agents.env.name")}
              aria-invalid={invalidName}
              aria-describedby={invalidName ? errorId : undefined}
              onChange={(e) => update(index, { name: e.target.value.trim() })}
            />
            {entry.sensitive ? (
              <CredentialField
                label={valueLabel}
                value={entry.value}
                references={references}
                onChange={(value) => update(index, { value })}
              />
            ) : (
              <Input
                className="mono"
                aria-label={valueLabel}
                value={typeof entry.value === "string" ? entry.value : ""}
                placeholder={t("agents.env.value")}
                autoComplete="off"
                onChange={(e) => update(index, { value: e.target.value })}
              />
            )}
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t("agents.secret.sensitive") + " " + (index + 1)}
              aria-pressed={Boolean(entry.sensitive)}
              disabled={saved || referenced}
              title={t("agents.secret.sensitive")}
              onClick={() =>
                update(index, {
                  sensitive: !entry.sensitive,
                  value:
                    typeof entry.value === "object" && "secret" in entry.value
                      ? entry.value.secret
                      : entry.value,
                })
              }
            >
              {entry.sensitive ? <Lock className="ic ic-sm" /> : <Unlock className="ic ic-sm" />}
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t("agents.env.remove") + " " + (entry.name || index + 1)}
              onClick={() => onChange(entries.filter((_, i) => i !== index))}
            >
              <X className="ic ic-sm" />
            </Button>
          </div>
        )
      })}
      {entries.some((e) => e.name && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)) && (
        <p className="error-text" id={errorId} role="alert">
          {t("agents.env.invalid")}
        </p>
      )}
      <Button
        size="sm"
        type="button"
        variant="ghost"
        className="agent-add"
        onClick={() => onChange([...entries, { name: "", value: "", sensitive: true }])}
      >
        <Plus className="ic ic-sm" />
        {t("agents.env.add")}
      </Button>
    </div>
  )
}

export function LiteralArguments({
  label,
  value,
  onChange,
}: {
  label: string
  value: unknown
  onChange: (args: string[]) => void
}) {
  const { t } = useLocale()
  const args = Array.isArray(value)
    ? value.filter((arg): arg is string => typeof arg === "string")
    : []
  return (
    <div className="agent-env" role="group" aria-label={label}>
      {args.map((arg, i) => (
        <div className="agent-input-row" key={i}>
          <Input
            className="mono"
            aria-label={t("agents.arguments.item") + " " + (i + 1)}
            value={arg}
            spellCheck={false}
            onChange={(e) => onChange(args.map((v, j) => (i === j ? e.target.value : v)))}
          />
          <Button
            size="icon"
            variant="ghost"
            type="button"
            aria-label={t("agents.arguments.remove") + " " + (i + 1)}
            onClick={() => onChange(args.filter((_, j) => j !== i))}
          >
            <X className="ic ic-sm" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="agent-add"
        onClick={() => onChange([...args, ""])}
      >
        <Plus className="ic ic-sm" />
        {t("agents.arguments.add")}
      </Button>
    </div>
  )
}
