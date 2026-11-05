/** 渲染进程在严格 CSP 下运行：内联脚本只能按哈希放行，界面照常工作。 */
import { expect, test } from "@playwright/test"
import { openThread } from "./projects"

test("the renderer runs under a CSP that blocks other inline scripts", async () => {
  const { app, page } = await openThread("csp")
  const violations: string[] = []
  page.on("console", (message) => {
    if (/content.security.policy|refused to|blocked by csp/i.test(message.text())) {
      violations.push(message.text())
    }
  })
  try {
    // 文档响应的 CSP：只允许自身资源、插件协议和内联 import map 的哈希。
    const csp = await page.evaluate(async () => {
      const response = await fetch("pigcode://app/index.html")
      return response.headers.get("content-security-policy")
    })
    expect(csp).toContain("default-src 'self'")
    expect(csp).toMatch(/script-src 'self' pigcode-plugin: 'sha256-[A-Za-z0-9+/]+=*'/)
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)

    // import map 的哈希对得上：界面已经渲染出来。
    await expect(page.locator("#root > *").first()).toBeVisible()

    // 没有哈希的内联脚本会被拦下。
    const ran = await page.evaluate(() => {
      const script = document.createElement("script")
      script.textContent = "window.__cspInlineRan = true"
      document.head.append(script)
      return (window as unknown as { __cspInlineRan?: boolean }).__cspInlineRan
    })
    expect(ran).toBeUndefined()
    await expect.poll(() => violations.length).toBeGreaterThan(0)
    expect(violations.join("\n")).toContain("Content Security Policy")

    // 之后正常使用不应该再出现任何拦截。
    violations.length = 0

    await page.locator(".tiptap").click()
    await page.keyboard.type("hello")
    await page.keyboard.press("Enter")
    await expect(page.getByText("Hello from fake agent")).toBeVisible({ timeout: 5000 })
    expect(violations).toEqual([])
  } finally {
    await app.close()
  }
})
