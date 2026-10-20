/** 审批卡片；按钮文案来自 locale，决议值沿用 allow-once / allow-for-session / deny。 */
import { Check, Hand } from "lucide-react"
import { Button, useLocale } from "@pigcode/ui-primitives"

/** 用户对审批请求的三种决议。 */
export type ApprovalDecision = "allow-once" | "allow-for-session" | "deny"

/** 一条待处理或已处理的审批请求。 */
export interface ApprovalRequest {
  id: string
  title: string | undefined
  description: string | undefined
  command: string | undefined
}

const RESOLVED_KEYS = {
  "allow-once": "chat.approval.allowedOnce",
  "allow-for-session": "chat.approval.allowedSession",
  deny: "chat.approval.denied",
} as const

/** 渲染审批请求；已处理时只显示结果行。 */
export function ApprovalCard({
  request,
  resolved,
  onApproval,
}: {
  request: ApprovalRequest
  resolved: ApprovalDecision | undefined
  onApproval: (requestId: string, decision: ApprovalDecision) => void
}) {
  const { t } = useLocale()

  if (resolved) {
    return (
      <div className="perm-done">
        <Check className="ic ic-sm" aria-hidden="true" />
        {t(RESOLVED_KEYS[resolved])}
      </div>
    )
  }

  return (
    <div className="perm" role="group" aria-label={t("chat.approval.title")}>
      <div className="q">
        <Hand className="ic" aria-hidden="true" />
        {request.title ?? request.description ?? t("chat.approval.title")}
      </div>
      {request.description && request.title ? <p>{request.description}</p> : null}
      {request.command ? <pre>{request.command}</pre> : null}
      <div className="acts">
        <Button variant="primary" onClick={() => onApproval(request.id, "allow-once")}>
          {t("chat.approval.allowOnce")}
        </Button>
        <Button variant="secondary" onClick={() => onApproval(request.id, "allow-for-session")}>
          {t("chat.approval.allowSession")}
        </Button>
        <Button variant="ghost" onClick={() => onApproval(request.id, "deny")}>
          {t("chat.approval.deny")}
        </Button>
      </div>
    </div>
  )
}
