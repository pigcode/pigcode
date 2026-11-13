/** 校验渲染进程描述的菜单项，弹出原生菜单并返回被选中的命令。 */
import type { BrowserWindow, MenuItemConstructorOptions } from "electron"

/** 渲染进程可以使用的系统角色；编辑类角色作用在弹出菜单前聚焦的元素上。 */
export const NATIVE_MENU_ROLES = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
  "resetZoom",
  "zoomIn",
  "zoomOut",
  "togglefullscreen",
  "reload",
  "toggleDevTools",
  "quit",
] as const

/** 允许的系统角色。 */
export type NativeMenuRole = (typeof NATIVE_MENU_ROLES)[number]

/** 只在开发构建里出现的角色；打包后丢弃，避免出现点了没反应的菜单项。 */
const DEV_ROLES: ReadonlySet<NativeMenuRole> = new Set(["reload", "toggleDevTools"])

/** 一个已校验的菜单项：分隔线、应用命令或系统角色。 */
export type NativeMenuItem =
  | { type: "separator" }
  | { id: string; label: string; accelerator?: string; enabled?: boolean }
  | { role: NativeMenuRole; label?: string }

/** 弹出位置，单位是页面 CSS 像素。 */
export interface MenuPosition {
  x: number
  y: number
}

const MAX_ITEMS = 48
const MAX_LABEL = 120
const MAX_ID = 64
/** 快捷键只做显示；允许 Electron accelerator 语法里的字符。 */
const ACCELERATOR = /^[A-Za-z0-9+`,.=/;'[\]\\-]{1,40}$/

function readText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null
}

/** 去掉开头、结尾与连续的分隔线；丢弃开发角色后不会留下空分组。 */
function tidySeparators(items: NativeMenuItem[]): NativeMenuItem[] {
  const result: NativeMenuItem[] = []
  for (const item of items) {
    const separator = "type" in item
    const previous = result.at(-1)
    if (separator && (previous === undefined || "type" in previous)) continue
    result.push(item)
  }
  while (result.length > 0 && "type" in (result.at(-1) as NativeMenuItem)) result.pop()
  return result
}

/**
 * 校验渲染进程传来的菜单描述。任何一项不合法都返回 null，主进程不弹出菜单；
 * allowDevRoles 为 false 时静默去掉开发角色。
 */
export function readNativeMenu(
  value: unknown,
  { allowDevRoles }: { allowDevRoles: boolean },
): NativeMenuItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) return null
  const items: NativeMenuItem[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) return null
    const record = entry as Record<string, unknown>
    if (record.type === "separator") {
      items.push({ type: "separator" })
      continue
    }
    if (record.role !== undefined) {
      const role = NATIVE_MENU_ROLES.find((candidate) => candidate === record.role)
      if (!role) return null
      if (!allowDevRoles && DEV_ROLES.has(role)) continue
      const label = record.label === undefined ? null : readText(record.label, MAX_LABEL)
      if (record.label !== undefined && label === null) return null
      items.push(label ? { role, label } : { role })
      continue
    }
    const id = readText(record.id, MAX_ID)
    const label = readText(record.label, MAX_LABEL)
    if (!id || !label) return null
    const item: { id: string; label: string; accelerator?: string; enabled?: boolean } = {
      id,
      label,
    }
    if (record.accelerator !== undefined) {
      if (typeof record.accelerator !== "string" || !ACCELERATOR.test(record.accelerator)) {
        return null
      }
      item.accelerator = record.accelerator
    }
    if (record.enabled === false) item.enabled = false
    items.push(item)
  }
  const tidy = tidySeparators(items)
  return tidy.length > 0 ? tidy : null
}

/** 校验弹出位置；负数夹到 0。 */
export function readMenuPosition(value: unknown): MenuPosition | null {
  if (typeof value !== "object" || value === null) return null
  const { x, y } = value as Record<string, unknown>
  if (typeof x !== "number" || typeof y !== "number") return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.max(0, x), y: Math.max(0, y) }
}

/**
 * 生成 Electron 菜单模板。应用命令的快捷键只显示不注册，
 * 按键仍由页面里的快捷键处理，避免同一个按键触发两次。
 */
export function menuTemplate(
  items: readonly NativeMenuItem[],
  onCommand: (id: string) => void,
): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    if ("type" in item) return { type: "separator" }
    if ("role" in item)
      return item.label ? { role: item.role, label: item.label } : { role: item.role }
    return {
      label: item.label,
      enabled: item.enabled ?? true,
      ...(item.accelerator ? { accelerator: item.accelerator, registerAccelerator: false } : {}),
      click: () => onCommand(item.id),
    }
  })
}

/** 构建菜单所需的 Electron 接口；测试里可以替换。 */
export interface MenuFactory {
  buildFromTemplate(template: MenuItemConstructorOptions[]): {
    popup(options: { window: BrowserWindow; x: number; y: number; callback: () => void }): void
  }
}

/**
 * 在窗口里弹出菜单。点击应用命令时返回它的 id；关闭菜单而没有选择命令时返回 null。
 * 有的平台先关闭菜单再派发点击，所以关闭后稍等一拍再结束。
 */
export function popupNativeMenu(
  factory: MenuFactory,
  window: BrowserWindow,
  items: readonly NativeMenuItem[],
  position: MenuPosition,
): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (id: string | null): void => {
      if (settled) return
      settled = true
      resolve(id)
    }
    const menu = factory.buildFromTemplate(menuTemplate(items, finish))
    menu.popup({
      window,
      x: Math.round(position.x),
      y: Math.round(position.y),
      callback: () => setTimeout(() => finish(null), 50),
    })
  })
}
