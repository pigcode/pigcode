/**
 * 工具调用的公共外壳（参照 ZCode 的 ToolLayout / ToolSummaryRow）：一行摘要——图标、动作
 * （运行中扫光）、对象、改动行数与失败状态——悬停时出现箭头，点开在下面显示详情。
 * 失败的原因挂在「执行失败」上，悬停可以看到并复制。
 */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Check, ChevronRight, Copy, type LucideIcon } from "lucide-react"
import { Tooltip, copyText, useLocale } from "@pigcode/ui-primitives"
import { useToolOpen } from "./tool-open"

/** 失败等状态词；tooltip 是悬停时显示的原因。 */
export interface ToolRowStatus {
  label: string
  tooltip?: string | undefined
}

/** 一行工具摘要的属性。 */
export interface ToolRowProps {
  /** 记住展开状态用的 key，通常是工具调用 id。 */
  id: string
  icon: LucideIcon
  /** 嵌套在分组或子 agent 里时不显示图标。 */
  showIcon?: boolean | undefined
  kind: ReactNode
  running?: boolean | undefined
  kindDetail?: ReactNode
  /** 在动作和摘要之间放一个「·」。 */
  separator?: boolean | undefined
  primary?: ReactNode
  secondary?: ReactNode
  diff?: { added: number; removed: number } | null | undefined
  status?: ToolRowStatus | null | undefined
  title?: string | undefined
  /** 展开后替换的摘要；hideSecondaryWhenOpen 在展开后去掉次要摘要。 */
  expandedPrimary?: ReactNode
  hideSecondaryWhenOpen?: boolean | undefined
  hideDiffWhenOpen?: boolean | undefined
  /** 第一次满足条件时自动展开一次，之后由用户决定。 */
  autoOpen?: boolean | undefined
  /** 一直展开、不能收起。 */
  forceOpen?: boolean | undefined
  /** 点击整行执行的动作；有动作时不展开。 */
  action?: { label: string; onActivate: () => void } | undefined
  /** 详情；不提供时这一行不能展开。 */
  children?: (() => ReactNode) | undefined
  dataStatus?: string | undefined
  className?: string | undefined
}

/** 改动行数：+N 绿色、-N 红色，等宽数字。 */
export function DiffCount({ added, removed }: { added: number; removed: number }) {
  if (added <= 0 && removed <= 0) return null
  return (
    <span className="diff-count" aria-label={`+${added} -${removed}`}>
      {added > 0 ? <span className="add">+{added}</span> : null}
      {removed > 0 ? <span className="del">-{removed}</span> : null}
    </span>
  )
}

/** 带悬停提示的状态词；提示里可以复制失败原因。 */
function StatusWord({ status }: { status: ToolRowStatus }) {
  const { t } = useLocale()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  if (!status.tooltip?.trim()) {
    return <span className="tool-row-status">{status.label}</span>
  }
  const tooltip = status.tooltip
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={150}
        // 空 title 挡住整行的原生提示，悬停时只出现失败原因这一个提示。
        render={<span className="tool-row-status has-tip" title="" />}
        onClick={(event) => event.stopPropagation()}
      >
        {status.label}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" align="start" sideOffset={6} className="tip-positioner">
          <Tooltip.Popup className="tip-popup tool-tip">
            <span className="tool-tip-text">{tooltip}</span>
            <button
              type="button"
              className="tool-tip-copy"
              aria-label={copied ? t("chat.toolCall.copied") : t("chat.toolCall.copyError")}
              title={copied ? t("chat.toolCall.copied") : t("chat.toolCall.copyError")}
              onClick={(event) => {
                event.stopPropagation()
                void copyText(tooltip).then(() => setCopied(true))
              }}
            >
              {copied ? (
                <Check className="ic ic-xs" aria-hidden="true" />
              ) : (
                <Copy className="ic ic-xs" aria-hidden="true" />
              )}
            </button>
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}

/** 渲染一行工具摘要与可展开的详情。 */
export function ToolRow({
  id,
  icon: Icon,
  showIcon = true,
  kind,
  running = false,
  kindDetail,
  separator = false,
  primary,
  secondary,
  diff,
  status,
  title,
  expandedPrimary,
  hideSecondaryWhenOpen = false,
  hideDiffWhenOpen = false,
  autoOpen = false,
  forceOpen = false,
  action,
  children,
  dataStatus,
  className,
}: ToolRowProps) {
  const { t } = useLocale()
  const canToggle = !action && Boolean(children) && !forceOpen
  const [stored, setOpen] = useToolOpen(id, false)
  const autoOpened = useRef(false)
  useEffect(() => {
    if (!autoOpen || autoOpened.current) return
    autoOpened.current = true
    setOpen(true)
  }, [autoOpen, setOpen])
  const open = !action && Boolean(children) && (forceOpen || stored)
  const shownPrimary = open && expandedPrimary !== undefined ? expandedPrimary : primary
  const shownSecondary = open && hideSecondaryWhenOpen ? null : secondary
  const shownDiff = diff && !(open && hideDiffWhenOpen) ? diff : null
  const hasSummary = Boolean(shownPrimary || shownSecondary || shownDiff || status)

  const activate = () => {
    if (action) action.onActivate()
    else if (canToggle) setOpen(!open)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    activate()
  }
  const interactive = Boolean(action) || canToggle

  return (
    <div
      className={["tool-row", open ? "is-open" : "", className ?? ""].filter(Boolean).join(" ")}
      data-status={dataStatus}
    >
      <div
        className="tool-row-head"
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-expanded={canToggle ? open : undefined}
        aria-label={action ? action.label : undefined}
        title={title}
        data-interactive={interactive || undefined}
        onClick={interactive ? activate : undefined}
        onKeyDown={interactive ? onKeyDown : undefined}
      >
        {showIcon ? <Icon className="ic ic-sm tool-row-icon" aria-hidden="true" /> : null}
        <span className={running ? "tool-row-kind tool-shimmer" : "tool-row-kind"}>{kind}</span>
        {kindDetail ? <span className="tool-row-detail">{kindDetail}</span> : null}
        {hasSummary ? (
          <span className="tool-row-summary">
            {separator ? <span className="tool-row-sep">·</span> : null}
            {shownPrimary ? <span className="tool-row-primary">{shownPrimary}</span> : null}
            {shownSecondary ? <span className="tool-row-secondary">{shownSecondary}</span> : null}
            {shownDiff ? <DiffCount added={shownDiff.added} removed={shownDiff.removed} /> : null}
            {status ? <StatusWord status={status} /> : null}
          </span>
        ) : null}
        {running ? <span className="sr-only">{t("chat.tool.running")}</span> : null}
        {canToggle || (forceOpen && children) ? (
          <ChevronRight className="ic ic-sm tool-row-chev" aria-hidden="true" />
        ) : null}
      </div>
      {open && children ? <div className="tool-row-body">{children()}</div> : null}
    </div>
  )
}
