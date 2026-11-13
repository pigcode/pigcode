/**
 * 实例展开后最上面的概览：一句介绍与官网链接，下面一块浅底的信息格——谁登录着（邮箱）、
 * 什么订阅或登录方式、CLI 版本与实际启动的可执行文件。没装、没登录或检测出错时，
 * 信息格下面一条提示说明怎么办；agent 支持的功能用一行小字列在最后。
 */
import type { ReactNode } from "react"
import { AlertTriangle, ExternalLink } from "lucide-react"
import { localizeText, type AgentStatus, type AgentSummary } from "@pigcode/contracts"
import { useLocale } from "@pigcode/ui-primitives"
import { agentFeatureKeys } from "./agent-features"
import { SensitiveText } from "./sensitive-text"

/** 一格信息：小标题与值；值缺省时显示一条短横。 */
function Stat({
  label,
  mono,
  title,
  children,
}: {
  label: string
  mono?: boolean | undefined
  title?: string | undefined
  children: ReactNode
}) {
  return (
    <div className="agent-stat">
      <dt>{label}</dt>
      <dd className={mono ? "mono truncate" : "truncate"} title={title}>
        {children ?? <span className="agent-stat-empty">—</span>}
      </dd>
    </div>
  )
}

/** 渲染概览；action 放在介绍那一行的右边（例如「设为新会话默认」）。 */
export function AgentOverview({
  agent,
  status,
  revealed = false,
  onReveal,
  action,
  onOpenExternal,
  versionControl,
}: {
  agent: AgentSummary
  status: AgentStatus | undefined
  revealed?: boolean | undefined
  onReveal?: (() => void) | undefined
  action?: ReactNode | undefined
  onOpenExternal?: ((url: string) => void) | undefined
  versionControl?: ReactNode
}) {
  const { locale, t } = useLocale()
  const supported = agent.features
    ? agentFeatureKeys.filter((feature) => agent.features?.[feature.key])
    : []
  const signedOut = status?.installed === true && status.authenticated === false
  const problem =
    status && !status.installed
      ? {
          title: t("agents.status.notInstalled"),
          detail: agent.installHint ? localizeText(agent.installHint, locale) : status.error,
        }
      : signedOut
        ? { title: t("agents.status.signedOut"), detail: t("agents.signedOutHint") }
        : status?.error || (!agent.registered && agent.error)
          ? { title: t("agents.error"), detail: status?.error ?? agent.error }
          : null
  const email = status?.authenticated ? (status.email ?? null) : null
  const account = email ? (
    <SensitiveText value={email} revealed={revealed} onToggle={() => onReveal?.()} />
  ) : status?.installed && status.authenticated === false ? (
    t("agents.status.signedOut")
  ) : null

  return (
    <div className="agent-overview">
      {agent.description || agent.homepage || action ? (
        <div className="agent-intro">
          <p className="agent-description">
            {agent.description ? localizeText(agent.description, locale) : null}
            {agent.homepage && onOpenExternal ? (
              <button
                type="button"
                className="agent-link"
                onClick={() => onOpenExternal(agent.homepage ?? "")}
              >
                {t("agents.homepage")}
                <ExternalLink className="ic ic-xs" aria-hidden="true" />
              </button>
            ) : null}
          </p>
          {action}
        </div>
      ) : null}
      <div className="agent-panel">
        <dl className="agent-stats">
          <Stat label={t("agents.account")}>
            {status ? (
              account
            ) : (
              <span className="agent-stat-empty">{t("agents.status.checking")}</span>
            )}
          </Stat>
          <Stat label={t("agents.plan")}>{status?.authenticated ? status.account : null}</Stat>
          <Stat label={t("agents.version")} mono>
            {versionControl ?? (status?.installed ? status.version : null)}
          </Stat>
          <Stat label={t("agents.command")} mono title={status?.command ?? undefined}>
            {status?.command ?? null}
          </Stat>
        </dl>
        {problem ? (
          <div className="agent-callout" role="note">
            <AlertTriangle className="ic ic-sm" aria-hidden="true" />
            <div>
              <strong>{problem.title}</strong>
              {problem.detail ? <p>{problem.detail}</p> : null}
            </div>
          </div>
        ) : null}
      </div>
      {supported.length > 0 ? (
        <p className="agent-features">
          <span>{t("agents.features")}</span>
          {supported.map((feature) => t(feature.labelKey)).join(" · ")}
        </p>
      ) : null}
    </div>
  )
}
