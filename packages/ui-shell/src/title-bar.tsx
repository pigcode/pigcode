/**
 * Windows/Linux 的标题栏：应用图标与「文件 编辑 视图 帮助」菜单。
 * 最小化、最大化与关闭按钮由系统叠加绘制，位置随桌面设置在左或右，
 * 所以内容只排在 titlebar-area 环境变量给出的空白区域里。
 */
import { useState, type MouseEvent } from "react"
import { Icon } from "./icon"

/** 标题栏菜单里的一项：分隔线、应用命令或系统角色（撤销、复制、缩放等）。 */
export type TitleBarMenuItem =
  | { type: "separator" }
  | { id: string; label: string; accelerator?: string; enabled?: boolean; run: () => void }
  | { role: string; label: string }

/** 一个顶层菜单。 */
export interface TitleBarMenu {
  id: string
  label: string
  items: readonly TitleBarMenuItem[]
}

/** 标题栏属性。 */
export interface TitleBarProps {
  menus: readonly TitleBarMenu[]
  /** 菜单栏的无障碍名称。 */
  label: string
}

/** 只把可以序列化的字段交给原生菜单；run 留在页面里执行。 */
function toNativeItem(item: TitleBarMenuItem) {
  if ("type" in item) return { type: "separator" as const }
  if ("role" in item) return { role: item.role, label: item.label }
  return {
    id: item.id,
    label: item.label,
    ...(item.accelerator ? { accelerator: item.accelerator } : {}),
    ...(item.enabled === false ? { enabled: false } : {}),
  }
}

/** 绘制标题栏；点击菜单名时由主进程弹出原生菜单，选中的命令回到页面执行。 */
export function TitleBar({ menus, label }: TitleBarProps) {
  const [openId, setOpenId] = useState<string | null>(null)

  async function open(menu: TitleBarMenu, button: HTMLButtonElement): Promise<void> {
    const popup = window.pigcodeNative?.popupMenu
    if (!popup) return
    const rect = button.getBoundingClientRect()
    setOpenId(menu.id)
    try {
      const picked = await popup(menu.items.map(toNativeItem), {
        x: rect.left,
        y: rect.bottom,
      })
      const item = menu.items.find((entry) => "id" in entry && entry.id === picked)
      if (item && "run" in item) item.run()
    } finally {
      setOpenId(null)
    }
  }

  return (
    <header className="titlebar">
      <span className="titlebar-icon" aria-hidden="true">
        <Icon name="snout" />
      </span>
      <nav className="titlebar-menus" aria-label={label}>
        {menus.map((menu) => (
          <button
            key={menu.id}
            type="button"
            className="titlebar-menu"
            aria-haspopup="menu"
            aria-expanded={openId === menu.id}
            // 不抢焦点：编辑菜单的撤销、复制等作用在原来聚焦的输入框上。
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
            onClick={(event) => void open(menu, event.currentTarget)}
          >
            {menu.label}
          </button>
        ))}
      </nav>
    </header>
  )
}
