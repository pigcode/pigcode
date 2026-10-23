/**
 * 在内置浏览器页面里执行的脚本。每个函数都自成一体（不引用外部变量），由 pageScript 序列化后
 * 交给 webContents.executeJavaScript；参数以 JSON 传入。
 */

/** 页面快照：可交互元素（带 ref）、标题层级与可见文字。 */
export interface PageSnapshot {
  url: string
  title: string
  elements: string[]
  headings: string[]
  text: string
  scroll: { y: number; height: number; viewport: number }
}

/** 定位到的元素：视口坐标（CSS 像素）与可读描述。 */
export interface LocatedElement {
  x: number
  y: number
  label: string
}

/** 元素定位方式：快照里的 ref、CSS 选择器或可见文字，优先级依次降低。 */
export interface ElementTarget {
  ref?: string | undefined
  selector?: string | undefined
  text?: string | undefined
}

/** 把函数与参数拼成可执行的脚本。 */
export function pageScript<A, R>(fn: (arg: A) => R, arg: A): string {
  return `(${fn.toString()})(${JSON.stringify(arg)})`
}

/** 给可见的可交互元素编号（data-pigcode-ref），并收集页面结构与文字。 */
export function pageSnapshot(options: { maxElements: number; maxText: number }): PageSnapshot {
  const interactive = [
    "a[href]",
    "button",
    "input:not([type=hidden])",
    "textarea",
    "select",
    "summary",
    "[role=button]",
    "[role=link]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=switch]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=option]",
    "[role=textbox]",
    "[role=combobox]",
    "[contenteditable='']",
    "[contenteditable=true]",
    "[onclick]",
  ].join(",")
  const clean = (text: string | null | undefined, max: number) =>
    (text ?? "").replace(/\s+/g, " ").trim().slice(0, max)
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return false
    const style = getComputedStyle(element)
    const opacity = style.opacity === "" ? 1 : Number(style.opacity)
    return style.visibility !== "hidden" && style.display !== "none" && opacity > 0.05
  }
  const roleOf = (element: HTMLElement) => {
    const explicit = element.getAttribute("role")
    if (explicit) return explicit
    if (element instanceof HTMLAnchorElement) return "link"
    if (element instanceof HTMLButtonElement || element.tagName === "SUMMARY") return "button"
    if (element instanceof HTMLSelectElement) return "combobox"
    if (element instanceof HTMLTextAreaElement || element.isContentEditable) return "textbox"
    if (element instanceof HTMLInputElement) {
      if (["button", "submit", "reset", "image"].includes(element.type)) return "button"
      if (element.type === "checkbox" || element.type === "radio") return element.type
      return element.type === "search" ? "searchbox" : "textbox"
    }
    return "clickable"
  }
  const nameOf = (element: HTMLElement) => {
    const labelled = element.getAttribute("aria-labelledby")
    const byId = labelled ? document.getElementById(labelled)?.textContent : null
    const field = element as HTMLInputElement
    return clean(
      element.getAttribute("aria-label") ||
        byId ||
        field.labels?.[0]?.textContent ||
        element.getAttribute("placeholder") ||
        element.getAttribute("title") ||
        element.getAttribute("alt") ||
        element.innerText ||
        (field.type === "submit" || field.type === "button" ? field.value : ""),
      80,
    )
  }
  for (const old of document.querySelectorAll("[data-pigcode-ref]")) {
    old.removeAttribute("data-pigcode-ref")
  }
  const elements: string[] = []
  for (const node of document.querySelectorAll(interactive)) {
    const element = node as HTMLElement
    if (!visible(element) || element.closest("[aria-hidden='true']")) continue
    if (elements.length >= options.maxElements) break
    const ref = `e${elements.length + 1}`
    element.setAttribute("data-pigcode-ref", ref)
    const parts = [`[${ref}]`, roleOf(element)]
    const name = nameOf(element)
    if (name) parts.push(JSON.stringify(name))
    const states: string[] = []
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.type === "password") states.push("password")
      else if (element.type === "checkbox" || element.type === "radio") {
        states.push((element as HTMLInputElement).checked ? "checked" : "unchecked")
      } else if (element.value) states.push(`value=${JSON.stringify(clean(element.value, 60))}`)
    }
    if (element instanceof HTMLSelectElement) {
      states.push(`value=${JSON.stringify(clean(element.selectedOptions[0]?.text, 40))}`)
    }
    if ((element as HTMLButtonElement).disabled) states.push("disabled")
    const rect = element.getBoundingClientRect()
    if (rect.bottom < 0 || rect.top > window.innerHeight) states.push("offscreen")
    if (states.length > 0) parts.push(`(${states.join(", ")})`)
    elements.push(parts.join(" "))
  }
  const headings = [...document.querySelectorAll("h1, h2, h3")]
    .filter(visible)
    .slice(0, 20)
    .map(
      (heading) => `${"#".repeat(Number(heading.tagName[1]))} ${clean(heading.textContent, 100)}`,
    )
  const text = (document.body?.innerText ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, options.maxText)
  return {
    url: location.href,
    title: document.title,
    elements,
    headings,
    text,
    scroll: {
      y: Math.round(window.scrollY),
      height: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
    },
  }
}

/** 找到目标元素并滚到视口中央，返回它中心点的视口坐标。 */
export function pageLocate(target: ElementTarget): LocatedElement | null {
  const clickable =
    "a[href],button,input,textarea,select,summary,label,[role],[onclick],[tabindex],[contenteditable]"
  const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim()
  let element: Element | null = null
  if (target.ref) element = document.querySelector(`[data-pigcode-ref="${target.ref}"]`)
  else if (target.selector) element = document.querySelector(target.selector)
  else if (target.text) {
    const wanted = target.text.toLowerCase()
    let best: { element: Element; score: number } | null = null
    for (const node of document.querySelectorAll(clickable)) {
      const rect = node.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) continue
      const label = clean(
        node.getAttribute("aria-label") ||
          (node as HTMLElement).innerText ||
          (node as HTMLInputElement).value ||
          node.getAttribute("placeholder"),
      ).toLowerCase()
      if (!label.includes(wanted)) continue
      const score = label === wanted ? 0 : label.length
      if (!best || score < best.score) best = { element: node, score }
    }
    element = best?.element ?? null
  }
  if (!element) return null
  element.scrollIntoView({ block: "center", inline: "center" })
  const rect = element.getBoundingClientRect()
  const html = element as HTMLElement
  const name = clean(
    html.getAttribute("aria-label") ||
      html.innerText ||
      (html as HTMLInputElement).value ||
      html.getAttribute("placeholder"),
  ).slice(0, 60)
  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    label: `${element.tagName.toLowerCase()}${name ? ` "${name}"` : ""}`,
  }
}

/** 聚焦输入目标；clear 时选中已有内容，接下来输入的文字会替换它。 */
export function pageFocus(input: ElementTarget & { clear: boolean }): string | null {
  let element: Element | null = null
  if (input.ref) element = document.querySelector(`[data-pigcode-ref="${input.ref}"]`)
  else if (input.selector) element = document.querySelector(input.selector)
  else element = document.activeElement
  if (!(element instanceof HTMLElement)) return null
  element.scrollIntoView({ block: "center", inline: "center" })
  element.focus()
  if (input.clear) {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      element.select()
    } else if (element.isContentEditable) {
      const range = document.createRange()
      range.selectNodeContents(element)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
  }
  const name =
    element.getAttribute("aria-label") ||
    (element as HTMLInputElement).labels?.[0]?.textContent ||
    element.getAttribute("placeholder") ||
    element.tagName.toLowerCase()
  return name.replace(/\s+/g, " ").trim().slice(0, 60)
}

/** 等待条件：文字出现、选择器匹配、地址包含某段；都满足时返回 true。 */
export function pageMatches(condition: {
  text?: string | undefined
  selector?: string | undefined
  url?: string | undefined
}): boolean {
  if (condition.text && !(document.body?.innerText ?? "").includes(condition.text)) return false
  if (condition.selector && !document.querySelector(condition.selector)) return false
  if (condition.url && !location.href.includes(condition.url)) return false
  return true
}

/** 按方向滚动一屏（或指定像素），返回滚动后的位置。 */
export function pageScroll(input: { dy: number }): { y: number; height: number; viewport: number } {
  window.scrollBy({ top: input.dy, behavior: "instant" as ScrollBehavior })
  return {
    y: Math.round(window.scrollY),
    height: document.documentElement.scrollHeight,
    viewport: window.innerHeight,
  }
}

/** 把快照整理成给 agent 读的文字。 */
export function formatSnapshot(snapshot: PageSnapshot): string {
  const lines = [`URL: ${snapshot.url}`, `Title: ${snapshot.title || "(none)"}`]
  if (snapshot.headings.length > 0) lines.push("Headings:", ...snapshot.headings)
  lines.push(
    snapshot.elements.length > 0
      ? "Interactive elements (pass ref to browser_click / browser_type):"
      : "Interactive elements: (none visible)",
    ...snapshot.elements,
  )
  const { y, height, viewport } = snapshot.scroll
  if (height > viewport) {
    lines.push(`Scroll: ${y}/${Math.max(0, height - viewport)}px (use browser_scroll to see more)`)
  }
  lines.push("Visible text:", snapshot.text || "(empty)")
  return lines.join("\n")
}
