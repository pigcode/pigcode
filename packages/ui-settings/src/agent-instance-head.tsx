import { CircleArrowUp, ChevronDown, LoaderCircle } from "lucide-react"
import { AgentIcon, agentBrandOf, StatusDot, Switch, useLocale } from "@pigcode/ui-primitives"
import type { AgentStatus, AgentCliUpdateState } from "@pigcode/contracts"
import type { AgentInstanceEntry } from "./agent-instances"
import { instanceHeadline } from "./agent-status"
import { SensitiveText } from "./sensitive-text"
/** 实例卡片的头部：整块是展开按钮，右边是启用开关（开关不跟着展开）。 */
export function InstanceHead({
  entry,
  status,
  open,
  sessionDefault,
  pending,
  revealed,
  onToggle,
  onReveal,
  onSetEnabled,
  update,
  onShowUpdate,
}: {
  entry: AgentInstanceEntry
  status: AgentStatus | undefined
  open: boolean
  sessionDefault: boolean
  pending: boolean
  /** 账号邮箱是否显示原文；默认遮住。 */
  revealed: boolean
  onToggle: () => void
  onReveal: () => void
  onSetEnabled: (enabled: boolean) => void
  update: AgentCliUpdateState | undefined
  onShowUpdate: () => void
}) {
  const { t } = useLocale()
  const { agent, instance, label } = entry
  const headline = instanceHeadline(agent, instance, status)
  const custom = !instance.isDefault
  const signedIn = headline.tone === "ready" && status?.authenticated === true
  const updating = Boolean(update && ["queued", "waiting", "running"].includes(update.phase))
  return (
    <div className="agent-row" data-open={open || undefined}>
      {/* 整块卡片头可点：展开按钮铺满这一块，邮箱的显示按钮浮在它上面，不嵌套按钮。 */}
      <div className="agent-row-main">
        <button
          type="button"
          className="agent-row-hit"
          id={"agent-select-" + instance.instanceId}
          aria-controls={open ? "agent-instance-details" : undefined}
          aria-expanded={open}
          aria-label={t("agents.select").replace("{instance}", label)}
          onClick={onToggle}
        />
        <span className="agent-tile" data-brand={agentBrandOf(agent.agentId) ?? undefined}>
          <AgentIcon
            agentId={agent.agentId}
            instanceId={instance.instanceId}
            accentColor={instance.accentColor}
            name={label}
            size="lg"
          />
        </span>
        <span className="agent-row-text">
          <span className="agent-row-title">
            <span className="agent-row-name truncate">{label}</span>
            {custom ? <code className="agent-row-id">{instance.instanceId}</code> : null}
            {sessionDefault && (
              <small className="agent-default-mark">{t("agents.instance.isSessionDefault")}</small>
            )}
          </span>
        </span>
        <span className="agent-row-status" data-tone={headline.tone}>
          <StatusDot tone={headline.tone} />
          <span className="agent-row-state">{t(headline.label)}</span>
          {signedIn && status?.email ? (
            <SensitiveText
              className="agent-row-email"
              value={status.email}
              revealed={revealed}
              onToggle={onReveal}
            />
          ) : null}
          {signedIn && status?.account ? (
            <span className="agent-plan truncate">{status.account}</span>
          ) : null}
        </span>
        {update && (update.available || updating) ? (
          <button
            className="icon-btn agent-row-update"
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
        <ChevronDown className="ic ic-sm agent-row-caret" aria-hidden="true" />
      </div>
      <Switch
        aria-label={t("agents.enable").replace("{agent}", label)}
        checked={agent.enabled && instance.enabled}
        disabled={pending}
        onCheckedChange={(checked) => onSetEnabled(checked)}
      />
    </div>
  )
}
