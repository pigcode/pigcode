/**
 * Host 返回的错误：有专门说明的错误码显示当前语言的解释，原始信息收在下面可以展开；
 * 其余错误原样显示信息。
 */
import { isHostErrorCode } from "@pigcode/contracts"
import { ChevronRight } from "lucide-react"
import { useLocale, type MessageKey } from "../locale/locale"
import { cn } from "./cn"
import { Collapsible } from "./collapsible"

/** 一次失败的错误码与原始信息；没有错误码时 code 为 null。 */
export interface HostErrorInfo {
  code: string | null
  message: string
}

/** 从 RPC 调用抛出的错误里读出错误码（Error 上的 code 字段）与原始信息。 */
export function toHostError(error: unknown): HostErrorInfo {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined
  return { code: typeof code === "string" ? code : null, message }
}

/** 错误码对应的说明文案；没有专门说明时返回 null。 */
export function hostErrorMessageKey(code: string | null): MessageKey | null {
  return isHostErrorCode(code) ? `hostError.${code}` : null
}

/** 错误提示；className 决定外观（例如 workbench-error）。 */
export function ErrorNotice({ error, className }: { error: HostErrorInfo; className?: string }) {
  const { t } = useLocale()
  const key = hostErrorMessageKey(error.code)
  if (!key) return <p className={className}>{error.message}</p>
  return (
    <Collapsible.Root className={cn("error-notice", className)}>
      <p className="error-notice-text">{t(key)}</p>
      <Collapsible.Trigger className="error-notice-toggle">
        <ChevronRight className="ic ic-xs" aria-hidden="true" />
        {t("hostError.details")}
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <pre className="error-notice-raw">{error.message}</pre>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}
