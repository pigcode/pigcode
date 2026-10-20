/** 执行计划卡片；步骤状态映射到 ok/warn/muted 三种图标。 */
import { useState } from "react"
import { Check, ChevronRight, Circle, Loader2 } from "lucide-react"
import { Button, useLocale } from "@pigcode/ui-primitives"

/** 计划步骤的三种状态。 */
export type PlanStepStatus = "pending" | "in-progress" | "completed"

/** 单条计划步骤。 */
export interface PlanStep {
  text: string
  status: PlanStepStatus
}

/** 一次计划更新。 */
export interface PlanUpdate {
  title: string | undefined
  steps: PlanStep[]
}

const STATUS_KEYS = {
  pending: "chat.plan.step.pending",
  "in-progress": "chat.plan.step.inProgress",
  completed: "chat.plan.step.completed",
} as const

/** 渲染可展开的计划卡片，默认展开以便跟踪进度。 */
export function PlanCard({ plan }: { plan: PlanUpdate }) {
  const { t } = useLocale()
  const [open, setOpen] = useState(true)

  return (
    <div className={`result plan-card${open ? " is-open" : ""}`}>
      <Button
        variant="plain"
        className="result-head"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight className="ic ic-sm chev" aria-hidden="true" />
        <span>{plan.title ?? t("chat.plan.title")}</span>
        <span className="grow" />
        <span className="muted">{open ? t("chat.hide") : t("chat.view")}</span>
      </Button>
      {open ? (
        <div className="result-body">
          <ol className="plan-steps">
            {plan.steps.map((step, index) => (
              <li key={`${step.text}-${index}`} data-status={step.status}>
                {step.status === "completed" ? (
                  <Check className="ic ic-sm" aria-hidden="true" />
                ) : step.status === "in-progress" ? (
                  <Loader2 className="ic ic-sm spin" aria-hidden="true" />
                ) : (
                  <Circle className="ic ic-sm" aria-hidden="true" />
                )}
                <span>{step.text}</span>
                <span className="sr-only">{t(STATUS_KEYS[step.status])}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  )
}
