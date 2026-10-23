/** 一轮回复结束后显示在下方的一行（参照 ZCode 的消息操作栏）：复制整轮回复与回复时间，悬停时出现。 */
import { useEffect, useState } from "react"
import { Check, Copy } from "lucide-react"
import { copyText, useLocale } from "@pigcode/ui-primitives"

function sameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

/**
 * 回复时间：当天只写「14:05」，前一天写「昨天 14:05」，今年写月日与时间，更早的再带上年份。
 * yesterday 是带 `{time}` 的文案。
 */
export function formatReplyTime(
  value: string,
  locale: string,
  yesterday: string,
  now = Date.now(),
): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  const today = new Date(now)
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date)
  if (sameDay(date, today)) return time
  const before = new Date(today)
  before.setDate(today.getDate() - 1)
  if (sameDay(date, before)) return yesterday.replace("{time}", time)
  return new Intl.DateTimeFormat(locale, {
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

/** 复制按钮与时间；复制成功后短暂显示对勾。 */
export function TurnActions({ text, at }: { text: string; at: string | null }) {
  const { t, locale } = useLocale()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const label = copied ? t("chat.message.copied") : t("chat.message.copy")
  return (
    <div className="turn-actions">
      <button
        type="button"
        className="turn-action"
        aria-label={label}
        title={label}
        onClick={() => void copyText(text).then(() => setCopied(true))}
      >
        {copied ? (
          <Check className="ic ic-sm" aria-hidden="true" />
        ) : (
          <Copy className="ic ic-sm" aria-hidden="true" />
        )}
      </button>
      {at ? (
        <time dateTime={at} title={new Date(at).toLocaleString(locale)}>
          {formatReplyTime(at, locale, t("chat.message.time.yesterday"))}
        </time>
      ) : null}
    </div>
  )
}
