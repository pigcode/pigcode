import { useEffect, useMemo, useState } from "react"
import type { Connection } from "@pigcode/client-runtime"
import {
  queueMethods,
  queuedMessagesSnapshot,
  type QueueSnapshot,
  type ThreadEvent,
} from "@pigcode/contracts"
import { Button, useLocale } from "@pigcode/ui-primitives"
import {
  checkDesktopQueueAfterReconnect,
  performDesktopQueueAction,
  recoverDesktopSend,
  usePendingDesktopQueueActions,
  usePendingDesktopSends,
  type DesktopQueueOperation,
} from "./desktop-message-recovery"

const queueUpdates = new Set<ThreadEvent["type"]>([
  "queue.changed",
  "run.queued",
  "run.started",
  "run.completed",
  "run.interrupted",
  "run.failed",
])

export function QueuedMessages({
  connection,
  threadId,
  events,
  connected,
  fail,
}: {
  connection: Connection
  threadId: string
  events: readonly ThreadEvent[]
  connected: boolean
  fail: (error: unknown) => void
}) {
  const { t } = useLocale()
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null)
  const [refresh, setRefresh] = useState(0)
  const unconfirmed = usePendingDesktopSends()
  const unconfirmedActions = usePendingDesktopQueueActions()
  const revision = useMemo(
    () => events.reduce((value, event) => (queueUpdates.has(event.type) ? event.seq : value), 0),
    [events],
  )

  useEffect(() => {
    if (!connected) return
    let current = true
    void connection
      .call(queueMethods.get, { threadId })
      .then((result) => {
        const parsed = queuedMessagesSnapshot.safeParse(result)
        if (current && parsed.success && parsed.data.threadId === threadId) setSnapshot(parsed.data)
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [connection, threadId, connected, revision, refresh])

  useEffect(() => {
    if (!connected) return
    for (const send of unconfirmed) {
      if (send.threadId === threadId) void recoverDesktopSend(connection, send, false, fail)
    }
  }, [connection, threadId, connected, unconfirmed, fail])

  useEffect(() => {
    if (connected) {
      void checkDesktopQueueAfterReconnect(connection, threadId, fail).then(() =>
        setRefresh((value) => value + 1),
      )
    }
  }, [connection, threadId, connected, fail])

  function perform(operation: DesktopQueueOperation, mode: "submit" | "check" | "retry") {
    if (!connected) return
    void performDesktopQueueAction(connection, operation, mode, fail).then(() =>
      setRefresh((value) => value + 1),
    )
  }

  const view = snapshot?.threadId === threadId ? snapshot : null
  const outstanding = unconfirmedActions.find((operation) => operation.threadId === threadId)
  const sends = unconfirmed.filter((send) => send.threadId === threadId)
  const working = outstanding?.working === true
  if (!view?.messages.length && !outstanding && !sends.length) return null
  const disabled = !connected || working || outstanding != null
  const submit = (method: DesktopQueueOperation["method"], messageId?: string, runId?: string) =>
    void perform(
      {
        method,
        commandId: crypto.randomUUID(),
        threadId,
        ...(messageId ? { messageId } : {}),
        ...(runId ? { runId } : {}),
      },
      "submit",
    )

  return (
    <section className="queued-messages" aria-label={t("chat.queue.title")}>
      <div className="queued-message-row">
        <span>{t(view?.paused ? "chat.queue.paused" : "chat.queue.title")}</span>
        {view?.paused ? (
          <Button
            size="sm"
            variant="plain"
            disabled={disabled}
            onClick={() => submit(queueMethods.resume)}
          >
            {t("chat.queue.resume")}
          </Button>
        ) : null}
      </div>
      {view?.messages.map((item) => {
        const imageCount = item.attachments?.length ?? 0
        const imageBadge =
          imageCount === 1
            ? t("chat.queue.imageSingle")
            : imageCount > 1
              ? t("chat.queue.imageMultiple").replace("{count}", String(imageCount))
              : null
        const title = [imageBadge, item.text].filter(Boolean).join(" ")
        return (
          <div className="queued-message-row" key={item.id}>
            <div className="queued-message-text" title={title}>
              {imageBadge ? (
                <span className="queued-message-attachments">{imageBadge}</span>
              ) : null}
              {item.text ? <span>{item.text}</span> : null}
            </div>
            {item.selected ? (
              <span>{t("chat.queue.selected")}</span>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="plain"
                  disabled={disabled}
                  onClick={() => submit(queueMethods.withdraw, item.id)}
                >
                  {t("chat.queue.withdraw")}
                </Button>
                {view.activeRunId ? (
                  <Button
                    size="sm"
                    variant="plain"
                    disabled={disabled}
                    onClick={() => submit(queueMethods.stopAndSend, item.id, view.activeRunId)}
                  >
                    {t("chat.queue.stopAndSend")}
                  </Button>
                ) : null}
              </>
            )}
          </div>
        )
      })}
      {outstanding ? (
        <div className="queued-message-row">
          <span role="status">{t("chat.queue.uncertain")}</span>
          <Button
            size="sm"
            variant="plain"
            disabled={!connected || working}
            onClick={() => void perform(outstanding, "check")}
          >
            {t("chat.queue.check")}
          </Button>
          <Button
            size="sm"
            variant="plain"
            disabled={!connected || working}
            onClick={() => void perform(outstanding, "retry")}
          >
            {t("chat.queue.retry")}
          </Button>
        </div>
      ) : null}
      {sends.map((send) => {
        const imageCount = send.options.attachmentIds?.length ?? 0
        const imageBadge =
          imageCount === 1
            ? t("chat.queue.imageSingle")
            : imageCount > 1
              ? t("chat.queue.imageMultiple").replace("{count}", String(imageCount))
              : null
        return (
          <div className="queued-message-row" key={send.commandId}>
            <span role="status">{t("chat.queue.uncertain")}</span>
            <div className="queued-message-text">
              {imageBadge ? (
                <span className="queued-message-attachments">{imageBadge}</span>
              ) : null}
              {send.text ? <span>{send.text}</span> : null}
            </div>
            <Button
              size="sm"
              variant="plain"
              disabled={!connected}
              onClick={() => void recoverDesktopSend(connection, send, false, fail)}
            >
              {t("chat.queue.check")}
            </Button>
            <Button
              size="sm"
              variant="plain"
              disabled={!connected}
              onClick={() => void recoverDesktopSend(connection, send, true, fail)}
            >
              {t("chat.queue.retry")}
            </Button>
          </div>
        )
      })}
    </section>
  )
}
