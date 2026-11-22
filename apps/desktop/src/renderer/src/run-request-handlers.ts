import type { Connection } from "@pigcode/client-runtime"
import { mobileRequestOutcome } from "@pigcode/contracts"
import type { ApprovalDecision } from "@pigcode/ui-chat"
import type { useLocale } from "@pigcode/ui-primitives"

interface Options {
  connection: Pick<Connection, "call">
  threadId: string | null
  latestRunId: () => string | null
  t: ReturnType<typeof useLocale>["t"]
  setNotice: (message: string) => void
  fail: (error: unknown) => void
}

export function runRequestHandlers({
  connection,
  threadId,
  latestRunId,
  t,
  setNotice,
  fail,
}: Options) {
  function submit(method: string, requestId: string, input: Record<string, unknown>): void {
    const runId = latestRunId()
    if (!runId || !threadId) return
    void connection
      .call(method, { threadId, runId, requestId, ...input })
      .then((result) => {
        const outcome = mobileRequestOutcome.safeParse(
          (result as { outcome?: unknown } | null)?.outcome,
        )
        if (!outcome.success || outcome.data.state === "applied") return
        if (outcome.data.state === "expired") {
          setNotice(t("chat.request.expired"))
          return
        }
        const labels = {
          "allow-once": "chat.approval.allowedOnce",
          "allow-for-session": "chat.approval.allowedSession",
          deny: "chat.approval.denied",
        } as const
        const { decision, answers } = outcome.data
        const detail = decision ? t(labels[decision]) : answers?.join(" / ")
        const message = t("chat.request.handledElsewhere")
        setNotice(detail ? `${message} · ${detail}` : message)
      })
      .catch(fail)
  }

  return {
    respondApproval: (requestId: string, decision: ApprovalDecision) =>
      submit("run.respondApproval", requestId, { decision }),
    answerQuestion: (requestId: string, answers: string[]) =>
      submit("run.answerQuestion", requestId, { answers }),
  }
}
