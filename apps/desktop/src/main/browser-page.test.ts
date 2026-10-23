/** 验证注入页面的脚本：快照编号、按 ref/文字定位、聚焦输入框与等待条件。 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { pageFocus, pageLocate, pageMatches, pageScript, pageSnapshot } from "./browser-page"

// jsdom 没有布局也没有 innerText：给每个元素一个可见的盒子，innerText 退回 textContent。
const hidden = new Set<string>()
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get(this: HTMLElement) {
      return this.textContent ?? ""
    },
  })
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const visible = !hidden.has(this.id)
    return {
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      width: visible ? 100 : 0,
      height: visible ? 30 : 0,
      right: 110,
      bottom: 50,
      toJSON: () => ({}),
    } as DOMRect
  }
  Element.prototype.scrollIntoView = () => undefined
  document.body.innerHTML = `
    <h1>登录 Demo</h1>
    <label for="email">邮箱</label><input id="email" type="email" placeholder="you@example.com" />
    <label for="password">密码</label><input id="password" type="password" value="secret" />
    <input id="agree" type="checkbox" checked aria-label="同意条款" />
    <button id="submit">登录</button>
    <button id="ghost">隐藏的按钮</button>
    <a href="/signup">注册</a>
    <p>还没有账号？</p>`
  hidden.add("ghost")
})

afterEach(() => {
  hidden.clear()
  document.body.innerHTML = ""
})

describe("page scripts", () => {
  it("number visible interactive elements and describe their state", () => {
    const snapshot = pageSnapshot({ maxElements: 50, maxText: 200 })
    expect(snapshot.elements).toEqual([
      '[e1] textbox "邮箱"',
      '[e2] textbox "密码" (password)',
      '[e3] checkbox "同意条款" (checked)',
      '[e4] button "登录"',
      '[e5] link "注册"',
    ])
    expect(snapshot.headings).toEqual(["# 登录 Demo"])
    expect(document.getElementById("submit")?.getAttribute("data-pigcode-ref")).toBe("e4")
    expect(document.getElementById("ghost")?.hasAttribute("data-pigcode-ref")).toBe(false)
    // 再拍一次会重新编号，不留下旧的 ref。
    hidden.add("email")
    pageSnapshot({ maxElements: 50, maxText: 200 })
    expect(document.getElementById("email")?.hasAttribute("data-pigcode-ref")).toBe(false)
    expect(document.getElementById("password")?.getAttribute("data-pigcode-ref")).toBe("e1")
  })

  it("locate elements by ref, selector or the closest text match", () => {
    pageSnapshot({ maxElements: 50, maxText: 200 })
    expect(pageLocate({ ref: "e4" })).toEqual({ x: 60, y: 35, label: 'button "登录"' })
    expect(pageLocate({ selector: "a[href='/signup']" })?.label).toBe('a "注册"')
    expect(pageLocate({ text: "登录" })?.label).toBe('button "登录"')
    expect(pageLocate({ ref: "e99" })).toBeNull()
    expect(pageLocate({ text: "不存在" })).toBeNull()
  })

  it("focus inputs by ref and select their text when clearing", () => {
    pageSnapshot({ maxElements: 50, maxText: 200 })
    expect(pageFocus({ ref: "e2", clear: true })).toBe("密码")
    const password = document.getElementById("password") as HTMLInputElement
    expect(document.activeElement).toBe(password)
    expect([password.selectionStart, password.selectionEnd]).toEqual([0, 6])
    expect(pageFocus({ ref: "e42", clear: false })).toBeNull()
  })

  it("check wait conditions and serialise with JSON arguments", () => {
    expect(pageMatches({ text: "还没有账号" })).toBe(true)
    expect(pageMatches({ selector: "#submit", text: "欢迎" })).toBe(false)
    expect(pageScript(pageMatches, { text: "x" })).toMatch(
      /^\(function pageMatches[\s\S]*\)\(\{"text":"x"\}\)$/,
    )
  })
})
