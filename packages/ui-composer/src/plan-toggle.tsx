import { Bot, ListChecks } from "lucide-react"
import { useLocale } from "@pigcode/ui-primitives"

/** 计划状态与权限并列；按钮沿用模型面板现有的图标开关。 */
export function PlanToggle({
  value,
  onChange,
}: {
  value: boolean
  onChange: (value: boolean) => void
}) {
  const { t } = useLocale()
  const Icon = value ? ListChecks : Bot
  return (
    <button
      type="button"
      className="model-plan-toggle"
      aria-label={t("composer.permission.plan")}
      aria-pressed={value}
      title={t("composer.permission.plan.description")}
      onClick={() => onChange(!value)}
    >
      <Icon className="ic ic-sm" aria-hidden="true" />
      <span>{t(value ? "composer.plan.short" : "composer.build.short")}</span>
    </button>
  )
}
