/** 右栏里的几行：名字（带取色按钮）、ID、恢复默认、删除。每行都是左边名字、右边控件。 */
import { useEffect, useState } from "react"
import { Check, Copy } from "lucide-react"
import type { AgentInstance } from "@pigcode/contracts"
import { Button, Input, SettingRow, useLocale, copyText } from "@pigcode/ui-primitives"
import { AccentPicker } from "./instance-accent"

/** 自己加的 Agent 的名字和颜色，一行；改动进草稿，跟其他设置一起保存。 */
export function InstanceNameRow({
  label,
  color,
  invalidLabel,
  saving,
  onLabelChange,
  onColorChange,
}: {
  label: string
  color: string | undefined
  invalidLabel: boolean
  saving: boolean
  onLabelChange: (value: string) => void
  onColorChange: (value: string | undefined) => void
}) {
  const { t } = useLocale()
  return (
    <SettingRow title={<label htmlFor="agent-instance-label">{t("agents.instance.name")}</label>}>
      <AccentPicker color={color} disabled={saving} onChange={onColorChange} />
      <Input
        id="agent-instance-label"
        className="agent-control"
        value={label}
        maxLength={120}
        disabled={saving}
        aria-invalid={invalidLabel || undefined}
        onChange={(event) => onLabelChange(event.target.value)}
      />
    </SettingRow>
  )
}

/** ID 一行，可以复制。 */
export function InstanceIdRow({ instance }: { instance: AgentInstance }) {
  const { t } = useLocale()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  return (
    <SettingRow
      title={t("agents.instance.idLabel")}
      value={<code className="agent-value mono">{instance.instanceId}</code>}
    >
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="agent-copy-btn"
        aria-label={
          copied ? t("agents.copied") : `${t("agents.copy")} ${t("agents.instance.idLabel")}`
        }
        title={copied ? t("agents.copied") : t("agents.copy")}
        onClick={() => {
          void copyText(instance.instanceId).then(() => setCopied(true))
        }}
      >
        {copied ? (
          <Check className="ic ic-sm" aria-hidden="true" />
        ) : (
          <Copy className="ic ic-sm" aria-hidden="true" />
        )}
      </Button>
    </SettingRow>
  )
}

/** 恢复默认：把改过的设置都还原，进草稿，保存后生效。 */
export function ResetRow({ disabled, onReset }: { disabled: boolean; onReset: () => void }) {
  const { t } = useLocale()
  return (
    <SettingRow title={t("agents.resetTitle")} description={t("agents.resetHint")}>
      <Button size="md" variant="secondary" type="button" disabled={disabled} onClick={onReset}>
        {t("agents.reset")}
      </Button>
    </SettingRow>
  )
}

/** 删除自己加的 Agent：先点「删除」，再点「确定删除」。 */
export function RemoveRow({ saving, onRemove }: { saving: boolean; onRemove: () => void }) {
  const { t } = useLocale()
  const [confirm, setConfirm] = useState(false)
  return (
    <SettingRow
      title={t("agents.instance.dangerTitle")}
      description={t("agents.instance.removeHint")}
    >
      {confirm ? (
        <>
          <Button size="md" variant="ghost" type="button" onClick={() => setConfirm(false)}>
            {t("agents.instance.cancel")}
          </Button>
          <Button
            size="md"
            variant="solidDanger"
            type="button"
            disabled={saving}
            onClick={onRemove}
          >
            {t("agents.instance.removeConfirm")}
          </Button>
        </>
      ) : (
        <Button
          size="md"
          variant="danger"
          type="button"
          disabled={saving}
          onClick={() => setConfirm(true)}
        >
          {t("agents.instance.remove")}
        </Button>
      )}
    </SettingRow>
  )
}
