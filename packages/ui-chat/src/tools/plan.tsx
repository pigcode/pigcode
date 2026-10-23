/**
 * 计划卡片（参照 ZCode 的 switch-mode）：agent 退出计划模式时交上来的计划。标题栏是「计划」与
 * 复制按钮，正文先显示一段、底部渐隐，点「查看完整计划」在原地展开。
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ArrowRight, Check, ChevronUp, Copy, NotepadText } from "lucide-react"
import { copyText, useLocale } from "@pigcode/ui-primitives"
import { MessageText } from "../message-item"
import { planMarkdown } from "../tool-fields"
import type { ToolCall } from "../tool-meta"
import { FallbackRow } from "./misc"

/** 计划卡片；没有计划内容时退回通用工具行。 */
export const PlanCard = memo(function PlanCard({ tool }: { tool: ToolCall }) {
  const { t } = useLocale()
  const plan = planMarkdown(tool)
  const body = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return undefined
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  useLayoutEffect(() => {
    const element = body.current
    if (!element || expanded) return
    setOverflowing(element.scrollHeight > element.clientHeight + 1)
  }, [plan, expanded])
  if (!plan) return <FallbackRow tool={tool} />
  return (
    <section className="plan-card" data-expanded={expanded || undefined}>
      <header className="plan-card-head">
        <NotepadText className="ic ic-sm" aria-hidden="true" />
        <span className="plan-card-title">{t("planTool.panel.planTab")}</span>
        <button
          type="button"
          className="plan-card-copy"
          aria-label={copied ? t("planTool.panel.copied") : t("planTool.panel.copy")}
          title={copied ? t("planTool.panel.copied") : t("planTool.panel.copy")}
          onClick={() => void copyText(plan).then(() => setCopied(true))}
        >
          {copied ? (
            <Check className="ic ic-xs" aria-hidden="true" />
          ) : (
            <Copy className="ic ic-xs" aria-hidden="true" />
          )}
        </button>
      </header>
      <div
        ref={body}
        className="plan-card-body md"
        data-clamped={!expanded && overflowing ? true : undefined}
      >
        <MessageText text={plan} />
      </div>
      {overflowing || expanded ? (
        <button
          type="button"
          className="plan-card-more"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? t("planTool.panel.collapse") : t("planTool.panel.viewFull")}
          {expanded ? (
            <ChevronUp className="ic ic-xs" aria-hidden="true" />
          ) : (
            <ArrowRight className="ic ic-xs" aria-hidden="true" />
          )}
        </button>
      ) : null}
    </section>
  )
})
