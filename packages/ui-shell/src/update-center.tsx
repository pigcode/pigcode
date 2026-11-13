/** 顶栏的统一更新入口，应用和 CLI 使用同一套紧凑列表。 */
import { useEffect, useRef, useState, type ReactNode } from "react"
import {
  Check,
  ChevronRight,
  CircleArrowUp,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
} from "lucide-react"
import type { AgentCliUpdateState, DesktopUpdateState } from "@pigcode/contracts"
import { AgentIcon, Button, Popover, useLocale, type MessageKey } from "@pigcode/ui-primitives"
import { Icon } from "./icon"
import { cliUpdateItems, cliUpdateRunning, hasAppUpdate } from "./update-items"

export interface UpdateCenterProps {
  app: DesktopUpdateState | null
  cli: Readonly<Record<string, AgentCliUpdateState>>
  agentNames: Readonly<Record<string, string>>
  open: boolean
  onOpenChange: (open: boolean) => void
  focusInstance?: string | null
  checking: boolean
  onCheck: () => Promise<void>
  onUpdateApp: () => Promise<void>
  onUpdateCli: (instanceId: string) => Promise<void>
}

const appActions: Record<NonNullable<DesktopUpdateState["action"]>, MessageKey> = {
  download: "updates.download",
  restart: "updates.restart",
  "open-package": "updates.openPackage",
  "open-release": "updates.openRelease",
}
const appErrors: Record<NonNullable<DesktopUpdateState["error"]>, MessageKey> = {
  check: "updates.checkFailed",
  download: "updates.downloadFailed",
  open: "updates.openFailed",
  install: "updates.installFailed",
}
const cliReasons: Record<NonNullable<AgentCliUpdateState["reason"]>, MessageKey> = {
  unsupported: "agents.cli.unsupported",
  "not-installed": "agents.cli.notInstalled",
  "unknown-installation": "agents.cli.unknownInstallation",
  "manager-unavailable": "agents.cli.managerUnavailable",
}

export function UpdateCenter(props: UpdateCenterProps) {
  const { t } = useLocale()
  const { app, cli, open } = props
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const visibleTargets = useRef(new Set<string>())
  const current = cliUpdateItems(cli)
  const items = cliUpdateItems(cli, open).filter(
    (item) => item.phase !== "succeeded" || visibleTargets.current.has(item.target),
  )
  useEffect(() => {
    if (!open) visibleTargets.current.clear()
    else for (const item of current) visibleTargets.current.add(item.target)
  }, [open, current])
  const count = current.length + Number(hasAppUpdate(app))
  const cliRunning = current.some(cliUpdateRunning)
  const running = cliRunning || app?.phase === "downloading"
  const focusTarget = props.focusInstance ? cli[props.focusInstance]?.target : null
  useEffect(() => {
    if (!open || !focusTarget) return
    const frame = requestAnimationFrame(() => {
      const rows = list.current?.querySelectorAll<HTMLElement>("[data-update-target]")
      Array.from(rows ?? [])
        .find((row) => row.dataset.updateTarget === focusTarget)
        ?.scrollIntoView({ block: "nearest" })
    })
    return () => cancelAnimationFrame(frame)
  }, [open, focusTarget])

  async function run(id: string, action: () => Promise<void>) {
    setPending(id)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  if (count === 0 && !open) return null
  const appBusy = app?.phase === "downloading" || app?.phase === "checking" || pending === "app"
  const restartBlocked = app?.action === "restart" && cliRunning
  const availableCli = current.filter(
    (item) => item.available && item.canUpdate && !cliUpdateRunning(item),
  )
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setError(null)
        props.onOpenChange(next)
      }}
    >
      <Popover.Trigger
        render={<Button variant="plain" className="icon-btn update-indicator" />}
        aria-label={t("updates.view")}
        title={
          running
            ? t("updates.inProgress")
            : count === 0
              ? t("updates.allCurrent")
              : t("updates.count").replace("{count}", String(count))
        }
      >
        {running ? (
          <LoaderCircle className="ic spin" aria-hidden="true" />
        ) : (
          <CircleArrowUp className="ic" aria-hidden="true" />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={8}>
          <Popover.Popup className="update-center-popup">
            <div className="update-center-head">
              <Popover.Title>{t("updates.title")}</Popover.Title>
              <Button
                variant="plain"
                size="icon"
                className="icon-btn"
                type="button"
                title={t("updates.check")}
                aria-label={t("updates.check")}
                disabled={props.checking || pending !== null}
                onClick={() => void run("check", props.onCheck)}
              >
                <RefreshCw
                  className={props.checking || pending === "check" ? "ic ic-sm spin" : "ic ic-sm"}
                  aria-hidden="true"
                />
              </Button>
            </div>
            <div className="update-center-list" ref={list}>
              {app && hasAppUpdate(app) ? (
                <UpdateRow
                  name="Pigcode"
                  icon={<Icon name="snout" />}
                  detail={
                    app.phase === "downloading"
                      ? t("updates.downloading") +
                        (app.progress === null ? "" : ` ${Math.floor(app.progress)}%`)
                      : app.phase === "ready"
                        ? t("updates.ready")
                        : app.error
                          ? t(appErrors[app.error])
                          : `${app.currentVersion} → ${app.version}`
                  }
                  busy={appBusy}
                  failed={app.phase === "failed"}
                  action={app.action ? t(appActions[app.action]) : t("updates.check")}
                  disabled={Boolean(appBusy || restartBlocked || pending)}
                  onAction={() => void run("app", props.onUpdateApp)}
                  target="app"
                  details={
                    <>
                      <span>{`${app.currentVersion} → ${app.version}`}</span>
                      {restartBlocked ? <p>{t("updates.waitForCli")}</p> : null}
                      {app.error ? <p role="alert">{t(appErrors[app.error])}</p> : null}
                      {app.url ? (
                        <button
                          className="update-release-link"
                          type="button"
                          onClick={() =>
                            void window.pigcodeNative
                              ?.openExternal?.(app.url!)
                              .catch((cause: unknown) =>
                                setError(cause instanceof Error ? cause.message : String(cause)),
                              )
                          }
                        >
                          {t("updates.releaseNotes")}
                        </button>
                      ) : null}
                    </>
                  }
                />
              ) : null}
              {items.map((item) => {
                const name =
                  props.agentNames[item.agentId] ??
                  props.agentNames[item.instanceId] ??
                  item.agentId
                const busy = cliUpdateRunning(item) || pending === item.target
                const finished = item.phase === "succeeded"
                const failed = item.phase === "failed" || item.phase === "unchanged"
                const detail =
                  item.phase === "waiting"
                    ? t("agents.cli.waiting")
                    : item.phase === "queued"
                      ? t("agents.cli.queued")
                      : item.phase === "running"
                        ? t("agents.cli.running")
                        : finished
                          ? t("updates.completed")
                          : failed
                            ? t("agents.cli.failed")
                            : `${item.currentVersion ?? "—"} → ${item.latestVersion ?? "—"}`
                return (
                  <UpdateRow
                    key={item.target}
                    target={item.target}
                    focused={item.target === focusTarget}
                    name={`${name} CLI`}
                    icon={<AgentIcon agentId={item.agentId} name={name} />}
                    detail={detail}
                    busy={busy}
                    failed={failed}
                    finished={finished}
                    action={t(failed ? "agents.cli.retry" : "agents.cli.updateShort")}
                    disabled={busy || Boolean(pending) || !item.canUpdate}
                    onAction={() => void run(item.target, () => props.onUpdateCli(item.instanceId))}
                    details={
                      <>
                        {item.reason ? <p>{t(cliReasons[item.reason])}</p> : null}
                        {item.command ? <code>{item.command}</code> : null}
                        {item.error ? <p role="alert">{item.error}</p> : null}
                        {item.output ? <pre>{item.output}</pre> : null}
                      </>
                    }
                  />
                )
              })}
              {count === 0 && items.length === 0 ? (
                <p className="update-center-empty">{t("updates.allCurrent")}</p>
              ) : null}
            </div>
            {error ? (
              <p className="update-center-error error-text" role="alert">
                {error}
              </p>
            ) : null}
            {availableCli.length > 1 ? (
              <div className="update-center-footer">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={Boolean(pending)}
                  onClick={() =>
                    void run("all", async () => {
                      await Promise.all(
                        availableCli.map((item) => props.onUpdateCli(item.instanceId)),
                      )
                    })
                  }
                >
                  {t("agents.cli.updateAll")}
                </Button>
              </div>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}

function UpdateRow({
  name,
  icon,
  detail,
  busy,
  failed,
  finished,
  action,
  disabled,
  onAction,
  details,
  target,
  focused,
}: {
  name: string
  icon: ReactNode
  detail: string
  busy?: boolean
  failed?: boolean
  finished?: boolean
  action: string
  disabled: boolean
  onAction: () => void
  details: ReactNode
  target: string
  focused?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      className="update-center-row"
      data-update-target={target}
      data-focused={focused || undefined}
    >
      <div className="update-center-item">
        <button
          type="button"
          className="update-center-summary"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span className="update-center-icon">{icon}</span>
          <span className="update-center-copy">
            <span className="update-center-name">{name}</span>
            <span className="update-center-meta" data-error={failed || undefined}>
              {detail}
            </span>
          </span>
          <ChevronRight className="ic ic-xs update-center-caret" aria-hidden="true" />
        </button>
        {busy ? (
          <LoaderCircle className="ic ic-sm spin update-center-state" aria-label={detail} />
        ) : finished ? (
          <Check className="ic ic-sm update-center-state" aria-label={detail} />
        ) : (
          <Button size="sm" type="button" disabled={disabled} onClick={onAction}>
            {action}
          </Button>
        )}
      </div>
      {expanded ? (
        <div className="update-center-details">
          {failed ? <CircleAlert className="ic ic-sm" aria-hidden="true" /> : null}
          {details}
        </div>
      ) : null}
    </div>
  )
}
