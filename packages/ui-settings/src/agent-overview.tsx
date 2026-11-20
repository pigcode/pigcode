/**
 * 右栏最上面的「状态」一行，参照 t3code：一句话说清现在怎么样——能用时是账号和套餐，
 * 有问题时前面一个彩色圆点，后面跟着怎么解决；安装、登录这些操作排在这句话下面。
 * 程序位置在「其他」一组里。
 */
import { useEffect, useState, type ReactNode } from "react"
import { Check, Copy } from "lucide-react"
import {
  localizeText,
  type AgentInstance,
  type AgentStatus,
  type AgentSummary,
} from "@pigcode/contracts"
import { Button, SettingRow, StatusDot, copyText, useLocale } from "@pigcode/ui-primitives"
import { SensitiveText } from "./sensitive-text"
import { instanceHeadline } from "./agent-status"
import { AgentBlockRow } from "./agent-section"

/** 一个要先解决的问题：没安装、出错或没登录。 */
export interface AgentProblemInfo {
  tone: "error" | "warning"
  title: string
  detail: string | null | undefined
}

/** 这个 Agent 现在有没有要先解决的问题；没有时返回 null。 */
export function useAgentProblem(
  agent: AgentSummary,
  status: AgentStatus | undefined,
  hasAccountSetup: boolean | undefined = agent.accountSetup,
): AgentProblemInfo | null {
  const { locale, t } = useLocale()
  const signedOut = status?.installed === true && status.authenticated === false
  if (status?.installed === false) {
    return {
      tone: "error",
      title: t("agents.status.notInstalled"),
      detail: agent.installHint ? localizeText(agent.installHint, locale) : status.error,
    }
  }
  if (status?.error || (!agent.registered && agent.error)) {
    return { tone: "error", title: t("agents.error"), detail: status?.error ?? agent.error }
  }
  if (!signedOut) return null
  return {
    tone: "warning",
    title: t("agents.status.signedOut"),
    detail: t(
      agent.acpRegistry || (hasAccountSetup && agent.agentId !== "antigravity")
        ? "agents.acp.signInHint"
        : hasAccountSetup
          ? "agents.setup.signInHint"
          : "agents.signedOutHint",
    ),
  }
}

/** 「状态」一行：现在怎么样，加上安装或登录的操作。 */
export function AgentStatusRow({
  agent,
  instance,
  status,
  revealed = false,
  onReveal,
  setup,
}: {
  agent: AgentSummary
  instance: AgentInstance
  status: AgentStatus | undefined
  revealed?: boolean | undefined
  onReveal?: (() => void) | undefined
  setup?: ReactNode
}) {
  const { t } = useLocale()
  const headline = instanceHeadline(agent, instance, status)
  const problem = useAgentProblem(agent, status, Boolean(setup))
  const email = status?.authenticated ? (status.email ?? null) : null
  const signedIn = status?.authenticated || status?.credentialsConfigured
  const plan = signedIn && status?.account ? status.account : null

  const settled = headline.tone !== "idle" && headline.tone !== "checking"
  let main: ReactNode = t(headline.label)
  let detail: ReactNode = null
  let tone: AgentProblemInfo["tone"] | undefined
  if (settled && problem) {
    tone = problem.tone
    main = problem.title
    detail = problem.detail
  } else if (settled) {
    if (email) {
      main = (
        <>
          {t("agents.status.signedInAs")}{" "}
          <SensitiveText value={email} revealed={revealed} onToggle={() => onReveal?.()} />
        </>
      )
    } else if (status?.usingCliLogin) {
      main = t("agents.setup.cliSignedIn")
    }
    detail = plan
  }

  return (
    <AgentBlockRow className="agent-status" title={t("agents.statusTitle")}>
      <p className="agent-status-line" data-tone={tone}>
        {tone ? <StatusDot tone={tone} /> : null}
        <span className="agent-status-main">{main}</span>
        {detail && !tone ? <span>· {detail}</span> : null}
      </p>
      {detail && tone ? <p className="agent-status-hint">{detail}</p> : null}
      {setup ? <div className="agent-status-setup">{setup}</div> : null}
    </AgentBlockRow>
  )
}

/** 程序位置一行，可以复制。 */
export function AgentCommand({ command }: { command: string | null | undefined }) {
  const { t } = useLocale()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])
  if (!command) return null
  return (
    <SettingRow
      title={t("agents.command")}
      value={
        <span className="agent-value mono truncate" title={command}>
          {command}
        </span>
      }
    >
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="agent-copy-btn"
        aria-label={copied ? t("agents.copied") : `${t("agents.copy")} ${t("agents.command")}`}
        title={copied ? t("agents.copied") : t("agents.copy")}
        onClick={() => {
          void copyText(command).then(() => setCopied(true))
        }}
      >
        {copied ? (
          <Check className="ic ic-sm" aria-hidden="true" />
        ) : (
          <Copy className="ic ic-sm" aria-hidden="true" />
        )}
      </Button>
    </SettingRow>
  )
}
