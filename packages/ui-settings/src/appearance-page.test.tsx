/** 外观设置页：模式缩略图、主题列表、颜色色片和主题代码面板都写进对应的外观设置。 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import {
  LocaleProvider,
  defaultAppearance,
  type AppearanceController,
  type AppearanceSettings,
  type ThemeDefinition,
} from "@pigcode/ui-primitives"
import { afterEach, describe, expect, it } from "vitest"
import { AppearancePage } from "./appearance-page"

afterEach(cleanup)

let latest: AppearanceSettings = defaultAppearance
let latestThemes: ThemeDefinition[] = []

function Harness() {
  const [settings, setSettings] = useState<AppearanceSettings>(defaultAppearance)
  const [customThemes, setCustomThemes] = useState<ThemeDefinition[]>([])
  latest = settings
  latestThemes = customThemes
  const controller = {
    settings,
    customThemes,
    resolved: "light",
    update: setSettings,
    saveCustomTheme: (theme: ThemeDefinition) => setCustomThemes((current) => [...current, theme]),
    removeCustomTheme: (id: string) =>
      setCustomThemes((current) => current.filter((theme) => theme.id !== id)),
    renameCustomTheme: () => {},
  } as unknown as AppearanceController
  return <AppearancePage appearance={controller} />
}

function renderPage() {
  render(
    <LocaleProvider locale="zh-CN">
      <Harness />
    </LocaleProvider>,
  )
}

/** 把「编辑哪一套颜色」切到深色。 */
function editDark() {
  const group = screen.getByRole("radiogroup", { name: "编辑哪一套颜色" })
  fireEvent.click(within(group).getByRole("radio", { name: "深色" }))
}

describe("AppearancePage", () => {
  it("picks the mode from the window thumbnails", () => {
    renderPage()
    const group = screen.getByRole("radiogroup", { name: "模式" })
    fireEvent.click(within(group).getByRole("radio", { name: "深色" }))
    expect(latest.mode).toBe("dark")
  })

  it("picks a theme from the gallery for the mode being edited only", () => {
    renderPage()
    editDark()
    const gallery = screen.getByRole("radiogroup", { name: "主题" })
    fireEvent.click(within(gallery).getByRole("radio", { name: "GitHub" }))
    expect(latest.dark.themeId).toBe("github")
    expect(latest.light.themeId).toBe("pigcode")
    expect(
      within(gallery).getByRole("radio", { name: "GitHub" }).getAttribute("aria-checked"),
    ).toBe("true")
  })

  it("writes a typed hex color into that mode only and can reset it", () => {
    renderPage()
    editDark()
    fireEvent.change(screen.getByLabelText("深色主题 · 新增行的十六进制值"), {
      target: { value: "#12ab34" },
    })
    expect(latest.overrides.pigcode?.dark?.diffAdded).toBe("#12AB34")
    expect(latest.overrides.pigcode?.light).toBeUndefined()
    fireEvent.click(screen.getByLabelText("恢复深色主题 · 新增行"))
    expect(latest.overrides).toEqual({})
  })

  it("custom accent switches the slot to a custom accent", () => {
    renderPage()
    fireEvent.change(screen.getByLabelText("浅色主题 · 强调色的十六进制值"), {
      target: { value: "#FF0066" },
    })
    expect(latest.light.accentMode).toBe("custom")
    expect(latest.dark.accentMode).toBe("default")
    expect(latest.overrides.pigcode?.light?.accent).toBe("#FF0066")
  })

  it("applies a pasted Codex theme to the dark mode", () => {
    renderPage()
    editDark()
    fireEvent.click(screen.getByRole("button", { name: "编辑代码" }))
    const area = screen.getByRole("textbox", { name: "深色主题" })
    expect((area as HTMLTextAreaElement).value).toMatch(/^pigcode-theme-v1:/)
    fireEvent.change(area, {
      target: {
        value:
          'codex-theme-v1:{"codeThemeId":"x","variant":"dark","theme":{"surface":"#1a1b26","ink":"#c0caf5","contrast":60,"fonts":{"ui":null,"code":"Fira Code"}}}',
      },
    })
    fireEvent.click(screen.getByRole("button", { name: "应用" }))
    expect(latest.overrides.pigcode?.dark).toEqual({ bg: "#1A1B26", fg: "#C0CAF5" })
    expect(latest.contrast).toBe(60)
    expect(latest.codeFont).toBe("fira")
    expect(screen.queryByRole("textbox", { name: "深色主题" })).toBeNull()
  })

  it("explains why a code cannot be applied and keeps editing", () => {
    renderPage()
    fireEvent.click(screen.getByRole("button", { name: "编辑代码" }))
    fireEvent.change(screen.getByRole("textbox", { name: "浅色主题" }), {
      target: { value: "not a theme" },
    })
    fireEvent.click(screen.getByRole("button", { name: "应用" }))
    expect(screen.getByRole("alert").textContent).toContain("不是主题代码")
    expect(screen.getByRole("textbox", { name: "浅色主题" })).toBeTruthy()
    expect(latest).toBe(defaultAppearance)
  })

  it("refuses a dark theme code pasted into the light theme", () => {
    renderPage()
    fireEvent.click(screen.getByRole("button", { name: "编辑代码" }))
    fireEvent.change(screen.getByRole("textbox", { name: "浅色主题" }), {
      target: { value: 'pigcode-theme-v1:{"variant":"dark","theme":{"surface":"#000000"}}' },
    })
    fireEvent.click(screen.getByRole("button", { name: "应用" }))
    expect(screen.getByRole("alert").textContent).toContain("深色主题的代码")
    expect(latest).toBe(defaultAppearance)
  })

  it("commits a typed font name on blur", () => {
    renderPage()
    const field = screen.getByLabelText("代码字体")
    fireEvent.change(field, { target: { value: "Berkeley Mono" } })
    fireEvent.blur(field)
    expect(latest.codeFont).toBe("Berkeley Mono")
  })

  it("selects a preset with the keyboard and resets to the system font", async () => {
    renderPage()
    const user = userEvent.setup()
    const field = screen.getByRole<HTMLInputElement>("combobox", { name: "界面字体" })

    await user.type(field, "Inter")
    await screen.findByRole("option", { name: "Inter" })
    await user.keyboard("{ArrowDown}{Enter}")
    expect(latest.light.uiFont).toBe("inter")
    expect(latest.dark.uiFont).toBe("inter")
    expect(field.value).toBe("Inter")

    await user.click(screen.getByRole("button", { name: "显示界面字体预设" }))
    await user.click(await screen.findByRole("option", { name: "系统默认" }))
    expect(latest.light.uiFont).toBe("system")
    expect(latest.dark.uiFont).toBe("system")
    expect(field.value).toBe("")
  })

  it("imports a theme file into my themes, uses it, and can delete it again", async () => {
    renderPage()
    const file = new File(
      [
        JSON.stringify({
          schema: "pigcode-theme/1",
          name: "Ocean",
          light: { bg: "#F0F8FF", fg: "#102030" },
          dark: { bg: "#001020", fg: "#E0F0FF", accent: "#33AAFF" },
        }),
      ],
      "ocean.pigcode-theme.json",
      { type: "application/json" },
    )
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Ocean"))
    const theme = latestThemes[0]!
    expect(theme.name).toBe("Ocean")
    expect(latest.light.themeId).toBe(theme.id)
    expect(latest.dark.themeId).toBe(theme.id)
    fireEvent.click(screen.getByRole("button", { name: "删除 Ocean" }))
    await waitFor(() => expect(latestThemes).toEqual([]))
    expect(latest.light.themeId).toBe("pigcode")
    expect(latest.dark.themeId).toBe("pigcode")
  })

  it("says why an imported file was refused", async () => {
    renderPage()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    fireEvent.change(input, { target: { files: [new File(["nope"], "bad.json")] } })
    expect((await screen.findByRole("alert")).textContent).toContain("不是主题代码")
    expect(latestThemes).toEqual([])
  })

  it("disables sidebar translucency where the system has no frosted material", () => {
    renderPage()
    expect(screen.getByText("需要系统的磨砂材质，只在 macOS 和 Windows 上可用")).toBeTruthy()
  })

  it("moves through the theme gallery with arrow keys, one tab stop for the group", () => {
    renderPage()
    const gallery = screen.getByRole("radiogroup", { name: "主题" })
    const radios = within(gallery).getAllByRole("radio")
    expect(radios.filter((radio) => radio.tabIndex === 0)).toHaveLength(1)
    radios[0]!.focus()
    fireEvent.keyDown(radios[0]!, { key: "ArrowRight" })
    expect(latest.light.themeId).toBe("chatgpt")
    expect(document.activeElement).toBe(radios[1])
    fireEvent.keyDown(radios[1]!, { key: "End" })
    expect(latest.light.themeId).toBe("solarized")
    fireEvent.keyDown(radios.at(-1)!, { key: "ArrowRight" })
    expect(latest.light.themeId).toBe("pigcode")
  })

  it("deleting a theme used by both modes does not split the modes", async () => {
    renderPage()
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!
    const code =
      'pigcode-theme-v1:{"variant":"light","theme":{"surface":"#FFFFFF","ink":"#000000"}}'
    fireEvent.change(input, { target: { files: [new File([code], "solo.txt")] } })
    await waitFor(() => expect(latestThemes).toHaveLength(1))
    expect(latest.splitModes).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "删除 solo" }))
    await waitFor(() => expect(latestThemes).toEqual([]))
    expect(latest.light.themeId).toBe("pigcode")
  })
})
