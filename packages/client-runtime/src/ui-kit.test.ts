/** 验证插件的 DOM 组件用宿主控件的类、开关与回调可用，以及主题与语言的观察器。 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createUiKit, observeLocale, observeTheme } from "./ui-kit"

afterEach(() => {
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("lang")
})

describe("createUiKit", () => {
  const ui = createUiKit()

  it("builds buttons, inputs, switches and badges with the host's control classes", () => {
    const onClick = vi.fn()
    const button = ui.button({ label: "Run", variant: "primary", onClick })
    expect(button.className).toBe("btn btn-primary pg-button")
    button.click()
    expect(onClick).toHaveBeenCalledOnce()
    expect(ui.button({ label: "Off", disabled: true }).disabled).toBe(true)

    const onChange = vi.fn()
    const input = ui.input({ label: "Name", value: "a", onChange })
    expect(input.className).toBe("input pg-input")
    expect(input.getAttribute("aria-label")).toBe("Name")
    input.value = "ab"
    input.dispatchEvent(new Event("input"))
    expect(onChange).toHaveBeenCalledWith("ab")

    const onToggle = vi.fn()
    const toggle = ui.toggle({ label: "Verbose", checked: false, onChange: onToggle })
    expect(toggle.getAttribute("role")).toBe("switch")
    expect(toggle.querySelector(".switch-thumb")).not.toBeNull()
    toggle.click()
    expect(toggle.getAttribute("aria-checked")).toBe("true")
    expect(onToggle).toHaveBeenCalledWith(true)

    expect(ui.badge("ok", "success").className).toBe("badge badge-ok pg-badge")
    expect(ui.badge("plain").className).toBe("badge pg-badge")
  })

  it("lays out sections, rows, lists, empty states and code", () => {
    const control = ui.badge("on")
    const section = ui.section({
      title: "Host",
      description: "What the plugin sees",
      children: [ui.row({ title: "Theme", description: "light or dark", control })],
    })
    expect(section.querySelector(".pg-section-title")?.textContent).toBe("Host")
    expect(section.querySelector(".pg-row-control")?.firstChild).toBe(control)

    const onClick = vi.fn()
    const list = ui.list([
      { title: "a.ts", description: "src", meta: "1 KB", onClick },
      { title: "b.ts" },
    ])
    const items = list.querySelectorAll(".pg-list-item")
    expect(items[0]?.tagName).toBe("BUTTON")
    expect(items[1]?.tagName).toBe("DIV")
    ;(items[0] as HTMLButtonElement).click()
    expect(onClick).toHaveBeenCalledOnce()
    expect(list.textContent).toBe("a.tssrc1 KBb.ts")

    expect(ui.empty({ title: "Nothing", description: "yet" }).textContent).toBe("Nothingyet")
    expect(ui.code("echo hi").querySelector("code")?.textContent).toBe("echo hi")
    expect(ui.text("muted", { tone: "muted", size: "sm" }).dataset).toMatchObject({
      tone: "muted",
      size: "sm",
    })
  })
})

describe("observers", () => {
  it("follow the root element's theme and language", async () => {
    const theme = observeTheme()
    const locale = observeLocale()
    expect(theme.get()).toBe("light")
    expect(locale.get()).toBe("zh-CN")
    const seen: string[] = []
    const stop = theme.subscribe((value) => seen.push(value))
    document.documentElement.setAttribute("data-theme", "dark")
    document.documentElement.setAttribute("lang", "en-US")
    await Promise.resolve()
    expect(seen).toEqual(["dark"])
    expect(locale.get()).toBe("en-US")
    stop()
    document.documentElement.setAttribute("data-theme", "light")
    await Promise.resolve()
    expect(seen).toEqual(["dark"])
  })
})
