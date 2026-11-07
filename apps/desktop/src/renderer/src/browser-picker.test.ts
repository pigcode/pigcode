/**
 * 验证选择网页元素：注入页面的脚本悬停时描边、点击时采集元素且不触发页面自己的点击、Esc 与取消得到 null、
 * 不采集输入框的值；采集结果变成输入框附件时的简称与 Markdown。
 */
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { translate, type MessageKey } from "@pigcode/ui-primitives"
import {
  CANCEL_PICKER_SCRIPT,
  elementContext,
  isPickedElement,
  pickerScript,
  type PickedElement,
} from "./browser-picker"

const THEME = {
  accent: "var(--accent)",
  label: "var(--primary)",
  labelText: "var(--on-primary)",
  font: "sans-serif",
}

/** 在页面里执行一段脚本，和 webview.executeJavaScript 一样拿到它的结果。 */
function run(script: string): unknown {
  return (0, eval)(script)
}

beforeAll(() => {
  // jsdom 的 CSS 对象没有 escape；真实的页面里一直都有。
  const escape = (value: string) => value.replace(/([^\w-])/g, "\\$1")
  const css = (globalThis as { CSS?: { escape?: unknown } }).CSS
  if (css && typeof css.escape !== "function") css.escape = escape
  else if (!css) Object.defineProperty(globalThis, "CSS", { configurable: true, value: { escape } })
})

afterEach(() => {
  document.body.innerHTML = ""
  Reflect.deleteProperty(document, "elementFromPoint")
})

function pointAt(element: Element): void {
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => element })
}

describe("picker script", () => {
  it("highlights the hovered element and captures it on click without clicking the page", async () => {
    document.title = "登录 Demo"
    document.body.innerHTML = `<main><form class="login card"><input name="email" value="me@example.com">
      <input type="password" value="hunter2"><button class="primary" aria-label="登录">登录</button></form></main>`
    const button = document.querySelector("button")!
    const pageClick = vi.fn()
    button.addEventListener("click", pageClick)
    pointAt(button)

    const result = run(pickerScript(THEME)) as Promise<unknown>
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }))
    const box = [...document.documentElement.children].find(
      (element) =>
        element instanceof HTMLDivElement && element.style.border.includes("var(--accent)"),
    ) as HTMLDivElement | undefined
    expect(box?.style.display).toBe("block")
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))

    const picked = await result
    expect(pageClick).not.toHaveBeenCalled()
    expect(isPickedElement(picked)).toBe(true)
    expect(picked).toMatchObject({
      title: "登录 Demo",
      tag: "button",
      name: "登录",
      text: "登录",
      selector: "main > form.login.card > button.primary",
    })
    // 选完以后页面恢复原样：高亮层和监听都拿掉了。
    expect(document.documentElement.querySelectorAll(":scope > div")).toHaveLength(0)
    expect((window as { __pigcodePick?: unknown }).__pigcodePick).toBeUndefined()
  })

  it("doesn't capture what was typed into fields", async () => {
    document.body.innerHTML = `<form id="signup"><input name="email" value="me@example.com">
      <input type="password" value="hunter2"><textarea>私密备注</textarea></form>`
    const form = document.querySelector("form")!
    pointAt(form)
    const result = run(pickerScript(THEME)) as Promise<PickedElement>
    form.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))
    const picked = await result
    expect(picked.selector).toBe("#signup")
    expect(picked.html).not.toContain("me@example.com")
    expect(picked.html).not.toContain("hunter2")
    expect(picked.html).not.toContain("私密备注")
    expect(picked.html).toContain('type="password"')
  })

  it("resolves null on Escape or when cancelled", async () => {
    document.body.innerHTML = "<p>hello</p>"
    pointAt(document.querySelector("p")!)
    const escaped = run(pickerScript(THEME)) as Promise<unknown>
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    expect(await escaped).toBeNull()

    const cancelled = run(pickerScript(THEME)) as Promise<unknown>
    run(CANCEL_PICKER_SCRIPT)
    expect(await cancelled).toBeNull()
  })
})

describe("elementContext", () => {
  const t = (key: MessageKey) => translate("zh-CN", key)
  const picked: PickedElement = {
    url: "http://localhost:3000/login",
    title: "登录 Demo",
    tag: "button",
    selector: "form > button.primary",
    name: null,
    text: "登录",
    html: '<button class="primary">登录</button>',
    size: { width: 120, height: 32 },
    style: "inline-block, 14px 500, rgb(255, 255, 255), rgb(37, 99, 235)",
  }

  it("labels the chip with the tag and text and describes the element in Markdown", () => {
    const context = elementContext(picked, t)
    expect(context.label).toBe("<button> 登录")
    expect(context.id).toBe("element:http://localhost:3000/login#form > button.primary")
    expect(context.markdown).toBe(
      [
        "### 网页元素：登录 Demo",
        "",
        "- 网址：http://localhost:3000/login",
        "- 选择器：`form > button.primary`",
        "- 文字：登录",
        "- 尺寸：120×32",
        "- 样式：inline-block, 14px 500, rgb(255, 255, 255), rgb(37, 99, 235)",
        "",
        "```html",
        '<button class="primary">登录</button>',
        "```",
      ].join("\n"),
    )
  })

  it("rejects results that aren't picked elements", () => {
    expect(isPickedElement(null)).toBe(false)
    expect(isPickedElement({ url: "x" })).toBe(false)
  })
})
