/** 版本号旁的更新操作，详细状态与日志按需展开。 */
import { useState } from "react"
import type { AgentCliUpdateState } from "@pigcode/contracts"
import { Button, Popover, useLocale, type MessageKey } from "@pigcode/ui-primitives"
import { Check, CircleAlert, Ellipsis, LoaderCircle, RefreshCw } from "lucide-react"

const reasons: Record<NonNullable<AgentCliUpdateState["reason"]>, MessageKey> = {
  unsupported: "agents.cli.unsupported",
  "not-installed": "agents.cli.notInstalled",
  "unknown-installation": "agents.cli.unknownInstallation",
  "manager-unavailable": "agents.cli.managerUnavailable",
}

export function AgentCliUpdate({
  version,
  state,
  checking,
  onCheck,
  onUpdate,
}: {
  version: string | null
  state: AgentCliUpdateState | undefined
  checking: boolean
  onCheck: () => Promise<void>
  onUpdate: () => Promise<void>
}) {
  const { t } = useLocale()
  const [pending, setPending] = useState<"check" | "update" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const active =
    state?.phase === "queued" || state?.phase === "waiting" || state?.phase === "running"
  const busy = checking || pending !== null || active
  const failure = error ?? state?.error
  let key: MessageKey = "agents.cli.notChecked"
  if (state?.reason) key = reasons[state.reason]
  else if (state?.phase === "queued") key = "agents.cli.queued"
  else if (state?.phase === "waiting") key = "agents.cli.waiting"
  else if (state?.phase === "running" || pending === "update") key = "agents.cli.running"
  else if (checking || pending === "check") key = "agents.cli.checking"
  else if (failure || state?.phase === "failed") key = "agents.cli.failed"
  else if (state?.phase === "succeeded") key = "agents.cli.succeeded"
  else if (state?.phase === "unchanged") key = "agents.cli.unchanged"
  else if (state?.available) key = "agents.cli.available"
  else if (state?.latestVersion) key = "agents.cli.current"
  else if (state) key = "agents.cli.unknownVersion"
  const message = t(key).replace(
    "{version}",
    key === "agents.cli.available" ? (state?.latestVersion ?? "") : (state?.currentVersion ?? ""),
  )
  const value = state?.currentVersion ?? version
  const canUpdate =
    state?.canUpdate &&
    (state.available ||
      !state.latestVersion ||
      state.phase === "failed" ||
      state.phase === "unchanged")
  const failed = Boolean(failure || state?.phase === "failed" || state?.phase === "unchanged")
  const upToDate = state?.phase === "succeeded" || Boolean(state?.latestVersion && !state.available)

  async function run(action: "check" | "update") {
    setPending(action)
    setError(null)
    try {
      await (action === "check" ? onCheck() : onUpdate())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  if (!value || state?.reason === "unsupported" || state?.reason === "not-installed") {
    return <span title={value ?? undefined}>{value ?? "—"}</span>
  }

  return (
    <span className="agent-cli-version">
      <span className="agent-cli-value truncate" title={value}>
        {value}
      </span>
      {canUpdate && !busy ? (
        <button
          className="agent-cli-action"
          type="button"
          aria-label={t("agents.cli.update")}
          title={
            state?.latestVersion
              ? t("agents.cli.available").replace("{version}", state.latestVersion)
              : t("agents.cli.update")
          }
          onClick={() => void run("update")}
        >
          {t(failed ? "agents.cli.retry" : "agents.cli.updateShort")}
        </button>
      ) : null}
      <Popover.Root>
        <Popover.Trigger
          className="icon-btn agent-cli-more"
          aria-label={t("agents.cli.details")}
          title={message}
          data-error={failed || undefined}
        >
          {busy ? (
            <LoaderCircle className="ic ic-xs spin" aria-hidden="true" />
          ) : failed ? (
            <CircleAlert className="ic ic-xs" aria-hidden="true" />
          ) : upToDate ? (
            <Check className="ic ic-xs" aria-hidden="true" />
          ) : (
            <Ellipsis className="ic ic-xs" aria-hidden="true" />
          )}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner side="bottom" align="end" sideOffset={8}>
            <Popover.Popup className="agent-cli-popup">
              <Popover.Title className="sr-only">{t("agents.cli.title")}</Popover.Title>
              <p className="agent-cli-status">{message}</p>
              {failure ? (
                <p className="error-text" role="alert">
                  {failure}
                </p>
              ) : null}
              {state?.command ? <code className="agent-cli-command">{state.command}</code> : null}
              {state?.output ? <pre className="agent-cli-output">{state.output}</pre> : null}
              <div className="agent-cli-popup-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={busy}
                  onClick={() => void run("check")}
                >
                  <RefreshCw className="ic ic-sm" aria-hidden="true" />
                  {t("agents.cli.check")}
                </Button>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <span className="sr-only" role="status">
        {message}
      </span>
    </span>
  )
}
