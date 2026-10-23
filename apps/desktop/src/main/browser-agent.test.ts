/** 验证内置浏览器的自动化：地址规则、按键映射，以及 agent 动作如何落到 webview 上。 */
import { describe, expect, it, vi } from "vitest"
import { BrowserAgent, type BrowserActivity, type GuestContents } from "./browser-agent"
import { keyEvents } from "./browser-keys"
import { isAllowedBrowserUrl, normalizeBrowserUrl } from "./browser-policy"

describe("browser policy", () => {
  it("allows http, https and about:blank only", () => {
    expect(isAllowedBrowserUrl("https://example.com/a")).toBe(true)
    expect(isAllowedBrowserUrl("http://localhost:5173")).toBe(true)
    expect(isAllowedBrowserUrl("about:blank")).toBe(true)
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "pigcode://app/index.html",
      "data:text/html,x",
      "",
    ]) {
      expect(isAllowedBrowserUrl(url)).toBe(false)
    }
  })

  it("completes ports, local hosts and domains", () => {
    expect(normalizeBrowserUrl("5173")).toBe("http://localhost:5173/")
    expect(normalizeBrowserUrl("localhost:3000/app")).toBe("http://localhost:3000/app")
    expect(normalizeBrowserUrl("[::1]:8080")).toBe("http://[::1]:8080/")
    expect(normalizeBrowserUrl("10.0.0.2:9000")).toBe("http://10.0.0.2:9000/")
    expect(normalizeBrowserUrl("example.com/docs")).toBe("https://example.com/docs")
    expect(normalizeBrowserUrl("file:///tmp/a.html")).toBeNull()
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull()
  })
})

describe("key events", () => {
  it("types characters, sends named keys and keeps shortcuts from typing", () => {
    expect(keyEvents("Enter")).toEqual([
      { type: "rawKeyDown", keyCode: "Enter", modifiers: [] },
      { type: "char", keyCode: "Enter", modifiers: [] },
      { type: "keyUp", keyCode: "Enter", modifiers: [] },
    ])
    expect(keyEvents("ArrowDown").map((event) => event.type)).toEqual(["rawKeyDown", "keyUp"])
    expect(keyEvents("ArrowDown")[0]?.keyCode).toBe("Down")
    expect(keyEvents("Control+A")).toEqual([
      { type: "rawKeyDown", keyCode: "A", modifiers: ["control"] },
      { type: "keyUp", keyCode: "A", modifiers: ["control"] },
    ])
    expect(keyEvents("Shift+a").map((event) => event.type)).toEqual(["rawKeyDown", "char", "keyUp"])
    expect(() => keyEvents("Hyper+x")).toThrow('Unknown modifier "Hyper"')
    expect(() => keyEvents("Banana")).toThrow('Unknown key "Banana"')
  })
})

/** 记录所有调用的 webview 替身；executeJavaScript 按脚本内容返回预设结果。 */
function fakeGuest(script: (code: string) => unknown = () => null) {
  let url = "about:blank"
  const calls: string[] = []
  const commands: Array<{ method: string; params: unknown }> = []
  const typed: string[] = []
  const keys: string[] = []
  const guest: GuestContents = {
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => url,
    getTitle: () => (url === "about:blank" ? "" : "Demo"),
    loadURL: async (next) => {
      calls.push(`load ${next}`)
      url = next
    },
    reload: () => calls.push("reload"),
    executeJavaScript: async (code) => script(code),
    insertText: async (text) => {
      typed.push(text)
    },
    sendInputEvent: (event) => keys.push(`${event.type}:${event.keyCode}`),
    capturePage: async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2560, height: 1600 }),
      resize: () => ({
        toJPEG: () => Buffer.from("jpeg"),
        getSize: () => ({ width: 1280, height: 800 }),
      }),
      toJPEG: () => Buffer.from("jpeg-full"),
    }),
    navigationHistory: {
      canGoBack: () => true,
      canGoForward: () => false,
      goBack: () => calls.push("back"),
      goForward: () => calls.push("forward"),
    },
    debugger: {
      isAttached: () => commands.length > 0,
      attach: () => calls.push("attach"),
      sendCommand: async (method, params) => {
        commands.push({ method, params })
        return {}
      },
    },
    once: () => guest,
    removeListener: () => guest,
  }
  return { guest, calls, commands, typed, keys, setUrl: (next: string) => (url = next) }
}

function setup(script?: (code: string) => unknown) {
  const fake = fakeGuest(script)
  const opened: Array<{ threadId: string; url: string | null }> = []
  const activity: BrowserActivity[] = []
  const agent = new BrowserAgent({
    requestOpen: (threadId, url) => opened.push({ threadId, url }),
    notifyActivity: (entry) => activity.push(entry),
    contentsFor: (id) => (id === 7 ? fake.guest : undefined),
    openTimeoutMs: 200,
  })
  const run = (action: string, params: Record<string, unknown> = {}) =>
    agent.handle({ type: "browser.request", id: 1, threadId: "th_1", action, params })
  return { agent, run, opened, activity, ...fake }
}

describe("BrowserAgent", () => {
  it("opens a browser tab for the thread and waits for its webview before navigating", async () => {
    const { agent, run, opened, calls, activity } = setup()
    const pending = run("open", { url: "localhost:4173" })
    await vi.waitFor(() =>
      expect(opened).toEqual([{ threadId: "th_1", url: "http://localhost:4173/" }]),
    )
    agent.register("browser-1", "th_1", 7)
    await expect(pending).resolves.toEqual({
      type: "browser.response",
      id: 1,
      ok: true,
      result: { text: 'Now at http://localhost:4173/ — "Demo".' },
    })
    expect(calls).toEqual(["load http://localhost:4173/"])
    expect(activity[0]).toMatchObject({ threadId: "th_1", sessionId: "browser-1", action: "open" })

    // 再次打开只把标签亮出来（url 为 null），然后在同一个 webview 里导航。
    await run("open", { url: "https://example.com" })
    expect(opened.at(-1)).toEqual({ threadId: "th_1", url: null })
    expect(calls.at(-1)).toBe("load https://example.com/")
  })

  it("refuses other protocols and asks for browser_open before acting", async () => {
    const { run } = setup()
    await expect(run("open", { url: "file:///etc/passwd" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("only http and https"),
    })
    await expect(run("click", { ref: "e1" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Call browser_open first"),
    })
  })

  it("times out when no webview shows up", async () => {
    const { run } = setup()
    await expect(run("open", {})).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("did not open"),
    })
  })

  it("clicks through CDP at the element centre and types and presses keys straight into the guest", async () => {
    const { agent, run, commands, typed, keys, activity } = setup((code) => {
      if (code.includes("pageLocate")) return { x: 120, y: 48, label: 'button "登录"' }
      if (code.includes("pageFocus")) return "邮箱"
      return null
    })
    agent.register("browser-1", "th_1", 7)
    await expect(run("click", { ref: "e3" })).resolves.toMatchObject({
      ok: true,
      result: { text: expect.stringContaining('Clicked button "登录"') },
    })
    expect(commands.map((command) => (command.params as { type: string }).type)).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ])
    expect(commands[1]?.params).toMatchObject({ x: 120, y: 48, button: "left", clickCount: 1 })
    expect(activity.at(-1)).toMatchObject({ action: "click", point: { x: 120, y: 48 } })

    await run("type", { ref: "e1", text: "demo@pigcode.dev", submit: true })
    expect(typed).toEqual(["demo@pigcode.dev"])
    expect(keys).toEqual(["rawKeyDown:Enter", "char:Enter", "keyUp:Enter"])
    // 文字与按键都没有走 CDP（CDP 会送到窗口里有焦点的输入框）。
    expect(commands.some((command) => command.method.startsWith("Input.insert"))).toBe(false)
    expect(commands.some((command) => command.method === "Input.dispatchKeyEvent")).toBe(false)
  })

  it("explains when an element is missing and formats snapshots for the agent", async () => {
    const { agent, run } = setup((code) => {
      if (code.includes("pageLocate")) return null
      if (code.includes("pageSnapshot")) {
        return {
          url: "http://localhost:4173/",
          title: "Demo 登录",
          elements: ['[e1] textbox "邮箱"', '[e2] button "登录"'],
          headings: ["# 登录 Demo"],
          text: "登录 Demo\n邮箱",
          scroll: { y: 0, height: 900, viewport: 800 },
        }
      }
      return null
    })
    agent.register("browser-1", "th_1", 7)
    await expect(run("click", { text: "注册" })).resolves.toMatchObject({
      ok: false,
      error: 'No element matches text "注册". Take a new browser_snapshot and try again.',
    })
    const snapshot = await run("snapshot")
    expect(snapshot.ok && snapshot.result.text).toBe(
      [
        "URL: http://localhost:4173/",
        "Title: Demo 登录",
        "Headings:",
        "# 登录 Demo",
        "Interactive elements (pass ref to browser_click / browser_type):",
        '[e1] textbox "邮箱"',
        '[e2] button "登录"',
        "Scroll: 0/100px (use browser_scroll to see more)",
        "Visible text:",
        "登录 Demo\n邮箱",
      ].join("\n"),
    )
  })

  it("captures a scaled JPEG screenshot and handles history and evaluation", async () => {
    const { agent, run, calls, setUrl } = setup((code) => (code === "1 + 1" ? 2 : undefined))
    agent.register("browser-1", "th_1", 7)
    setUrl("http://localhost:4173/welcome")
    const shot = await run("screenshot")
    expect(shot).toMatchObject({
      ok: true,
      result: {
        text: "Screenshot of http://localhost:4173/welcome (1280×800).",
        image: { data: Buffer.from("jpeg").toString("base64"), mimeType: "image/jpeg" },
      },
    })
    await run("navigate", { action: "back" })
    expect(calls).toContain("back")
    await expect(run("navigate", { action: "forward" })).resolves.toMatchObject({
      result: { text: expect.stringContaining("Cannot go forward") },
    })
    await expect(run("evaluate", { expression: "1 + 1" })).resolves.toMatchObject({
      result: { text: "2" },
    })
  })

  it("forgets closed tabs", async () => {
    const { agent, run } = setup()
    agent.register("browser-1", "th_1", 7)
    agent.unregister("browser-1")
    await expect(run("snapshot")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Call browser_open first"),
    })
  })
})
