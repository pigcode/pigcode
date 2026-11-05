/** 提供最小本地化能力；M0-B 只覆盖 shell/chat/settings 的可见文案。 */
import { createContext, useContext, useMemo, type ReactNode } from "react"
import { enUS } from "./messages.en-US"
import { zhCN } from "./messages.zh-CN"

export type Locale = "zh-CN" | "en-US"
export type MessageKey = keyof typeof zhCN

const dictionaries: Record<Locale, Record<MessageKey, string>> = {
  "zh-CN": zhCN,
  "en-US": enUS,
}

/** 不经过 React 读取一条文案；时间格式化这类纯函数用它。 */
export function translate(locale: Locale, key: MessageKey): string {
  return dictionaries[locale][key]
}

/**
 * 这个键有没有文案。文案的键可能来自 Host 或 Agent（例如会话提示），版本不一致时会出现
 * 当前语言包里没有的键；调用方据此决定退回显示键名，而不是显示 undefined。
 */
export function isMessageKey(key: string): key is MessageKey {
  return key in zhCN
}

interface LocaleValue {
  locale: Locale
  t: (key: MessageKey) => string
}

const LocaleContext = createContext<LocaleValue | null>(null)

/** 提供 locale 与 t()。 */
export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo(
    () => ({ locale, t: (key: MessageKey) => translate(locale, key) }),
    [locale],
  )
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

/** 读取当前 locale；外面没有 LocaleProvider 时抛错。 */
export function useLocale(): LocaleValue {
  const value = useContext(LocaleContext)
  if (!value) throw new Error("useLocale must be used inside LocaleProvider")
  return value
}
