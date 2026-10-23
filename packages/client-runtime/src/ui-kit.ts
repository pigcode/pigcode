/**
 * 插件用的 DOM 组件（ClientUiKit 的实现）：按钮、输入框、开关与徽标直接用宿主控件的类
 * （btn、input、switch、badge），和宿主界面一模一样；分组、设置行、列表等排版用 pg-* 类，
 * 样式在宿主的 plugins.css 里。另有宿主主题与语言的观察器，插件据此切换自己的内容。
 */
import type {
  ClientButtonVariant,
  ClientObservable,
  ClientTheme,
  ClientTone,
  ClientUiKit,
} from "@pigcode/plugin-sdk"

const BUTTON_CLASSES: Record<ClientButtonVariant, string> = {
  primary: "btn btn-primary",
  secondary: "btn btn-secondary",
  ghost: "btn btn-ghost",
  danger: "btn btn-danger",
}

const BADGE_CLASSES: Record<ClientTone, string> = {
  neutral: "badge",
  accent: "badge badge-primary",
  success: "badge badge-ok",
  warning: "badge badge-warn",
  danger: "badge badge-bad",
}

function create<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** 创建一套绑定到 doc 的组件。 */
export function createUiKit(doc: Document = document): ClientUiKit {
  return {
    section({ title, description, children = [] }) {
      const section = create(doc, "section", "pg-section")
      if (title || description) {
        const head = create(doc, "header", "pg-section-head")
        if (title) head.append(create(doc, "h3", "pg-section-title", title))
        if (description) head.append(create(doc, "p", "pg-section-desc", description))
        section.append(head)
      }
      const body = create(doc, "div", "pg-section-body")
      body.append(...children)
      section.append(body)
      return section
    },
    row({ title, description, control }) {
      const row = create(doc, "div", "pg-row")
      const main = create(doc, "div", "pg-row-main")
      main.append(create(doc, "span", "pg-row-title", title))
      if (description) main.append(create(doc, "span", "pg-row-desc", description))
      row.append(main)
      if (control) {
        const trail = create(doc, "div", "pg-row-control")
        trail.append(control)
        row.append(trail)
      }
      return row
    },
    button({ label, variant = "secondary", disabled = false, onClick }) {
      const button = create(doc, "button", `${BUTTON_CLASSES[variant]} pg-button`, label)
      button.type = "button"
      button.disabled = disabled
      if (onClick) button.addEventListener("click", () => onClick())
      return button
    },
    input({ label, value = "", placeholder, onChange }) {
      const input = create(doc, "input", "input pg-input")
      input.type = "text"
      input.value = value
      input.setAttribute("aria-label", label)
      if (placeholder) input.placeholder = placeholder
      if (onChange) input.addEventListener("input", () => onChange(input.value))
      return input
    },
    toggle({ label, checked, onChange }) {
      const toggle = create(doc, "button", "switch pg-toggle")
      toggle.type = "button"
      toggle.setAttribute("role", "switch")
      toggle.setAttribute("aria-label", label)
      toggle.setAttribute("aria-checked", String(checked))
      toggle.append(create(doc, "span", "switch-thumb"))
      toggle.addEventListener("click", () => {
        const next = toggle.getAttribute("aria-checked") !== "true"
        toggle.setAttribute("aria-checked", String(next))
        onChange?.(next)
      })
      return toggle
    },
    badge(label, tone = "neutral") {
      return create(doc, "span", `${BADGE_CLASSES[tone]} pg-badge`, label)
    },
    text(content, { tone = "default", size = "md" } = {}) {
      const text = create(doc, "p", "pg-text", content)
      text.dataset.tone = tone
      text.dataset.size = size
      return text
    },
    code(content) {
      const pre = create(doc, "pre", "pg-code")
      pre.append(create(doc, "code", "", content))
      return pre
    },
    list(items) {
      const list = create(doc, "ul", "pg-list")
      for (const item of items) {
        const entry = create(doc, "li", "pg-list-entry")
        const body = item.onClick
          ? create(doc, "button", "pg-list-item")
          : create(doc, "div", "pg-list-item")
        if (body instanceof HTMLButtonElement) {
          body.type = "button"
          body.addEventListener("click", () => item.onClick?.())
        }
        const text = create(doc, "span", "pg-list-text")
        text.append(create(doc, "span", "pg-list-title", item.title))
        if (item.description) text.append(create(doc, "span", "pg-list-desc", item.description))
        body.append(text)
        if (item.meta) body.append(create(doc, "span", "pg-list-meta", item.meta))
        entry.append(body)
        list.append(entry)
      }
      return list
    },
    empty({ title, description }) {
      const empty = create(doc, "div", "pg-empty")
      empty.append(create(doc, "strong", "pg-empty-title", title))
      if (description) empty.append(create(doc, "p", "pg-empty-desc", description))
      return empty
    },
  }
}

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
