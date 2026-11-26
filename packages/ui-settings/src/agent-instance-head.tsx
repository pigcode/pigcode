import type { KeyboardEvent } from "react"
import { CircleArrowUp, LoaderCircle } from "lucide-react"
import { AgentIcon, StatusDot, Switch, useLocale } from "@pigcode/ui-primitives"
import type { AgentStatus, AgentCliUpdateState } from "@pigcode/contracts"
import type { AgentInstanceEntry } from "./agent-instances"
import { instanceHeadline } from "./agent-status"

/**
 * 列表里的一个 Agent：图标，名字和版本，下面一行状态，右边是开关。点这一行选中它，右边换成它的设置。
 * 状态只有出问题时（没安装、没登录、出错）才带彩色圆点；能用时跟着账号的套餐。
 */
export function InstanceItem({
  entry,
  status,
  selected,
  dirty = false,
  pending,
  onSelect,
  onKeyDown,
  onSetEnabled,
  update,
  onShowUpdate,
}: {
  entry: AgentInstanceEntry
  status: AgentStatus | undefined
  selected: boolean
  dirty?: boolean | undefined
  pending: boolean
  onSelect: () => void
  onKeyDown?: ((event: KeyboardEvent<HTMLButtonElement>) => void) | undefined
  onSetEnabled: (enabled: boolean) => void
  update: AgentCliUpdateState | undefined
  onShowUpdate: () => void
}) {
  const { t } = useLocale()
  const { agent, instance, label } = entry
  const headline = instanceHeadline(agent, instance, status)
  const enabled = agent.enabled && instance.enabled
  const updating = Boolean(update && ["queued", "waiting", "running"].includes(update.phase))
  const id = instance.instanceId
  const version = status?.installed ? status.version : null
  const problem = headline.tone === "error" || headline.tone === "warning"
  const plan =
    headline.tone === "ready" && (status?.authenticated || status?.credentialsConfigured)
      ? status.account
      : null

  return (
    <div
      className="agent-item"
      role="listitem"
      data-selected={selected || undefined}
      data-disabled={!enabled || undefined}
    >
      <button
        type="button"
        className="agent-item-hit"
        id={"agent-select-" + id}
        aria-label={t("agents.select").replace("{instance}", label)}
        aria-current={selected || undefined}
        aria-controls={selected ? "agent-detail" : undefined}
        onClick={onSelect}
        onKeyDown={onKeyDown}
      />
      <div className="agent-item-main">
        <AgentIcon
          agentId={agent.agentId}
          instanceId={id}
          accentColor={instance.accentColor}
          name={label}
          size="lg"
        />
        <span className="agent-item-text">
          <span className="agent-item-title">
            <span className="agent-item-name">{label}</span>
            {version ? <code className="agent-item-version">{version}</code> : null}
            {dirty ? (
              <span
                className="agent-item-dirty"
                title={t("agents.unsaved")}
                aria-label={t("agents.unsaved")}
              />
            ) : null}
          </span>
          <span className="agent-item-status" data-tone={headline.tone}>
            {problem ? <StatusDot tone={headline.tone} /> : null}
            <span className="agent-item-state">
              {t(headline.label)}
              {plan ? ` · ${plan}` : ""}
            </span>
          </span>
        </span>
        {update && ((update.available && update.currentVersion !== null) || updating) ? (
          <button
            className="icon-btn agent-item-update"
            type="button"
            aria-label={t("updates.agent").replace("{agent}", label)}
            title={
              updating
                ? t("updates.inProgress")
                : t("agents.cli.available").replace("{version}", update.latestVersion ?? "")
            }
            onClick={onShowUpdate}
          >
            {updating ? (
              <LoaderCircle className="ic ic-sm spin" aria-hidden="true" />
            ) : (
              <CircleArrowUp className="ic ic-sm" aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>
      <Switch
        size="sm"
        aria-label={t("agents.enable").replace("{agent}", label)}
        checked={enabled}
        disabled={pending}
        onCheckedChange={onSetEnabled}
      />
    </div>
  )
}
