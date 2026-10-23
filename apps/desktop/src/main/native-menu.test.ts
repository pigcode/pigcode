/** 验证标题栏菜单的输入校验、模板生成与弹出后的返回值。 */
import type { BrowserWindow, MenuItemConstructorOptions } from "electron"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  menuTemplate,
  popupNativeMenu,
  readMenuPosition,
  readNativeMenu,
  type MenuFactory,
} from "./native-menu"

afterEach(() => {
  vi.useRealTimers()
})

describe("readNativeMenu", () => {
  it("accepts commands, roles and separators", () => {
    expect(
      readNativeMenu(
        [
          { id: "new-thread", label: "新会话", accelerator: "CmdOrCtrl+N" },
          { id: "terminal", label: "切换底部终端", accelerator: "Ctrl+`", enabled: false },
          { type: "separator" },
          { role: "copy", label: "复制" },
          { role: "quit" },
        ],
        { allowDevRoles: true },
      ),
    ).toEqual([
      { id: "new-thread", label: "新会话", accelerator: "CmdOrCtrl+N" },
      { id: "terminal", label: "切换底部终端", accelerator: "Ctrl+`", enabled: false },
      { type: "separator" },
      { role: "copy", label: "复制" },
      { role: "quit" },
    ])
  })

  it("rejects unknown roles, bad text and bad accelerators", () => {
    const options = { allowDevRoles: true }
    expect(readNativeMenu([{ role: "help" }], options)).toBeNull()
    expect(readNativeMenu([{ id: "", label: "空" }], options)).toBeNull()
    expect(readNativeMenu([{ id: "x", label: 3 }], options)).toBeNull()
    expect(
      readNativeMenu([{ id: "x", label: "x", accelerator: "Ctrl+<script>" }], options),
    ).toBeNull()
    expect(readNativeMenu([{ role: "copy", label: "" }], options)).toBeNull()
    expect(readNativeMenu("menu", options)).toBeNull()
    expect(readNativeMenu([], options)).toBeNull()
    expect(
      readNativeMenu(
        Array.from({ length: 49 }, () => ({ role: "copy" })),
        options,
      ),
    ).toBeNull()
  })

  it("drops developer roles in packaged builds and tidies separators", () => {
    expect(
      readNativeMenu(
        [
          { role: "zoomIn" },
          { type: "separator" },
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
        ],
        { allowDevRoles: false },
      ),
    ).toEqual([{ role: "zoomIn" }])
    expect(readNativeMenu([{ role: "reload" }], { allowDevRoles: false })).toBeNull()
  })
})

describe("readMenuPosition", () => {
  it("accepts finite coordinates and clamps negatives", () => {
    expect(readMenuPosition({ x: 12.5, y: -3 })).toEqual({ x: 12.5, y: 0 })
    expect(readMenuPosition({ x: Number.NaN, y: 1 })).toBeNull()
    expect(readMenuPosition({ x: "1", y: 1 })).toBeNull()
    expect(readMenuPosition(null)).toBeNull()
  })
})

describe("menuTemplate", () => {
  it("shows command shortcuts without registering them", () => {
    const onCommand = vi.fn()
    const [command, separator, role] = menuTemplate(
      [
        { id: "settings", label: "设置", accelerator: "CmdOrCtrl+," },
        { type: "separator" },
        { role: "undo", label: "撤销" },
      ],
      onCommand,
    )
    expect(command).toMatchObject({
      label: "设置",
      accelerator: "CmdOrCtrl+,",
      registerAccelerator: false,
      enabled: true,
    })
    expect(separator).toEqual({ type: "separator" })
    expect(role).toEqual({ role: "undo", label: "撤销" })
    ;(command?.click as () => void)()
    expect(onCommand).toHaveBeenCalledWith("settings")
  })
})

/** 记录模板与弹出参数的菜单替身；由测试决定何时点击、何时关闭。 */
function fakeFactory() {
  const state: {
    template: MenuItemConstructorOptions[]
    popup: { x: number; y: number; callback: () => void } | null
  } = { template: [], popup: null }
  const factory: MenuFactory = {
    buildFromTemplate(template) {
      state.template = template
      return {
        popup(options) {
          state.popup = options
        },
      }
    },
  }
  const click = (index: number) => (state.template[index]?.click as () => void)()
  return { state, factory, click }
}

describe("popupNativeMenu", () => {
  const window = {} as BrowserWindow
  const items = [
    { id: "new-thread", label: "新会话" },
    { id: "settings", label: "设置" },
  ]

  it("pops up at the rounded position and resolves the clicked command", async () => {
    const { state, factory, click } = fakeFactory()
    const result = popupNativeMenu(factory, window, items, { x: 10.4, y: 35.6 })
    expect(state.popup).toMatchObject({ x: 10, y: 36 })
    click(1)
    state.popup?.callback()
    await expect(result).resolves.toBe("settings")
  })

  it("resolves null when the menu closes without a command", async () => {
    vi.useFakeTimers()
    const { state, factory } = fakeFactory()
    const result = popupNativeMenu(factory, window, items, { x: 0, y: 0 })
    state.popup?.callback()
    await vi.runAllTimersAsync()
    await expect(result).resolves.toBeNull()
  })

  it("still reports a click that arrives right after the menu closes", async () => {
    vi.useFakeTimers()
    const { state, factory, click } = fakeFactory()
    const result = popupNativeMenu(factory, window, items, { x: 0, y: 0 })
    state.popup?.callback()
    click(0)
    await vi.runAllTimersAsync()
    await expect(result).resolves.toBe("new-thread")
  })
})
