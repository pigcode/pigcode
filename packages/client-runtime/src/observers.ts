/**
 * 宿主主题与语言的观察器，供 `ctx.theme`、`ctx.locale` 使用。React 组件里优先用 ui-primitives 的
 * `useTheme()`、`useLocale()`；这两个观察器留给不在组件里读取宿主状态的插件代码。
 */
import type { ClientObservable, ClientTheme } from "@pigcode/plugin-sdk"

/** 元素上某个属性的当前值与变化。 */
export function observeAttribute<T>(
  target: HTMLElement,
  attribute: string,
  read: (value: string | null) => T,
): ClientObservable<T> {
  return {
    get: () => read(target.getAttribute(attribute)),
    subscribe(listener) {
      const observer = new MutationObserver(() => listener(read(target.getAttribute(attribute))))
      observer.observe(target, { attributes: true, attributeFilter: [attribute] })
      return () => observer.disconnect()
    },
  }
}

/** 宿主的明暗主题，来自根元素的 data-theme。 */
export function observeTheme(
  root: HTMLElement = document.documentElement,
): ClientObservable<ClientTheme> {
  return observeAttribute(root, "data-theme", (value) => (value === "dark" ? "dark" : "light"))
}

/** 宿主的界面语言，来自根元素的 lang。 */
export function observeLocale(
  root: HTMLElement = document.documentElement,
): ClientObservable<string> {
  return observeAttribute(root, "lang", (value) => value || "zh-CN")
}
