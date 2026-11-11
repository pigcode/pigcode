/**
 * 输入框里的上下文占用：一个小圆环，填充比例是「已用 / 上限」；悬停看到具体数字和离自动压缩还剩多少。
 * 不知道上限时只显示已用，不画比例。
 */
import { Tooltip, useLocale } from "@pigcode/ui-primitives"

/** 会话当前的上下文占用；和 context.updated 事件的字段一致。 */
export interface ContextUsage {
  usedTokens: number
  maxTokens: number | null
  autoCompactTokens: number | null
}

/**
 * token 数的简写（参照 t3code）：<1000 原样，<10k 保留一位小数加 k，<1m 取整加 k，再往上用 m。
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0"
  if (value < 1_000) return String(Math.round(value))
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  if (value < 999_500) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`
}

/** 圆环的填充比例和程度：80% 起提醒，95% 起警告；不知道上限时为 null。 */
export function contextLevel(usage: ContextUsage): {
  ratio: number
  level: "ok" | "high" | "full"
} | null {
  const limit = usage.autoCompactTokens ?? usage.maxTokens
  if (!limit) return null
  const ratio = Math.max(0, Math.min(1, usage.usedTokens / limit))
  return { ratio, level: ratio >= 0.95 ? "full" : ratio >= 0.8 ? "high" : "ok" }
}

const RADIUS = 6
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const { t } = useLocale()
  const level = contextLevel(usage)
  const used = formatTokens(usage.usedTokens)
  const percent =
    usage.maxTokens !== null ? Math.round((usage.usedTokens / usage.maxTokens) * 100) : null
  const summary =
    usage.maxTokens !== null && percent !== null
      ? t("composer.context.used")
          .replace("{used}", used)
          .replace("{max}", formatTokens(usage.maxTokens))
          .replace("{percent}", String(percent))
      : t("composer.context.usedOnly").replace("{used}", used)
  const compact =
    usage.autoCompactTokens !== null
      ? t("composer.context.compact")
          .replace("{at}", formatTokens(usage.autoCompactTokens))
          .replace("{left}", formatTokens(Math.max(0, usage.autoCompactTokens - usage.usedTokens)))
      : null
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={150}
        render={
          <span
            className="context-meter"
            data-level={level?.level ?? "unknown"}
            role="img"
            aria-label={[t("composer.context.label"), summary, compact].filter(Boolean).join("，")}
          />
        }
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle className="context-meter-track" cx="8" cy="8" r={RADIUS} />
          {level ? (
            <circle
              className="context-meter-fill"
              cx="8"
              cy="8"
              r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * level.ratio} ${CIRCUMFERENCE}`}
            />
          ) : null}
        </svg>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner side="top" sideOffset={6}>
          <Tooltip.Popup className="context-meter-tip">
            <strong>{t("composer.context.label")}</strong>
            <span>{summary}</span>
            {compact ? <span>{compact}</span> : null}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
