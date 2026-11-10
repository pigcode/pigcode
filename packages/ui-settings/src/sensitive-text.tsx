/**
 * 默认遮住的敏感文字（参照 t3code 设置页的账号邮箱）：先显示一串打乱的同长字符并模糊，
 * 点一下显示原文，再点一下遮回去。打乱的字符由原文算出，同一个邮箱每次看起来一样，
 * 保留 @ . - _ 这些分隔符，一眼能认出是邮箱，但读不出内容；截图、录屏或共享屏幕时不会泄露账号。
 */
import { useMemo } from "react"
import { useLocale } from "@pigcode/ui-primitives"

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"

/** 由原文确定地生成同长的占位字符，分隔符原样保留。 */
export function maskText(value: string): string {
  let state = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index)
    state = Math.imul(state, 0x01000193)
  }
  const next = () => {
    state = Math.imul(state ^ (state >>> 13), 0x85ebca6b)
    state = Math.imul(state ^ (state >>> 16), 0xc2b2ae35)
    return ALPHABET[Math.abs(state) % ALPHABET.length] ?? "x"
  }
  return Array.from(value, (char) => ("@.-_".includes(char) ? char : next())).join("")
}

/** 渲染可以点开的敏感文字；revealed 由调用方保管，同一个账号在几处一起显示或遮住。 */
export function SensitiveText({
  value,
  revealed,
  onToggle,
  className,
}: {
  value: string
  revealed: boolean
  onToggle: () => void
  className?: string | undefined
}) {
  const { t } = useLocale()
  const masked = useMemo(() => maskText(value), [value])
  const hint = revealed ? t("agents.account.hide") : t("agents.account.reveal")
  return (
    <button
      type="button"
      className={className ? `sensitive ${className}` : "sensitive"}
      data-revealed={revealed || undefined}
      aria-label={hint}
      aria-pressed={revealed}
      title={hint}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
    >
      <span className="truncate" aria-hidden={!revealed || undefined}>
        {revealed ? value : masked}
      </span>
    </button>
  )
}
