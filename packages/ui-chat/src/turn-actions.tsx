/** 一轮回复结束后显示在下方的一行（参照 ZCode 的消息操作栏）：复制整轮回复与回复时间，悬停时出现。 */
import { useEffect, useState } from "react"
import { Check, Copy } from "lucide-react"
import { copyText, formatDateTime, formatReplyTime, useLocale } from "@pigcode/ui-primitives"

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
        <time dateTime={at} title={formatDateTime(at, locale)}>
          {formatReplyTime(at, locale)}
        </time>
      ) : null}
    </div>
  )
}
