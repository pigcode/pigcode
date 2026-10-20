/** 应用界面语言控制器；与 React 解耦，供 renderer 订阅。 */
export type Locale = "zh-CN" | "en-US"

/** 保存当前语言并通知订阅者，默认使用简体中文。 */
export class LocaleController {
  private locale: Locale = "zh-CN"
  private readonly listeners = new Set<(locale: Locale) => void>()

  getLocale = (): Locale => this.locale

  setLocale = (locale: Locale): void => {
    if (locale === this.locale) return
    this.locale = locale
    for (const listener of this.listeners) listener(locale)
  }

  subscribe = (listener: (locale: Locale) => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
