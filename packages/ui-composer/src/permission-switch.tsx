/** 模型选择器底栏的权限切换。 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { Check, ChevronDown } from "lucide-react"
import { formatShortcut, useLocale } from "@pigcode/ui-primitives"
import { permissionKeys, type PermissionMode } from "./composer-options"
import { PERMISSION_ICONS } from "./permission-menu"

/**
 * 底栏的权限按钮：点开后在面板里向上展开一列权限。展开的列表画在弹层里面，
 * 点它不算点到弹层外面，不会把整个选择器关掉。
 */
export function PermissionSwitch({
  value,
  modes,
  onChange,
}: {
  value: PermissionMode
  modes: readonly PermissionMode[]
  onChange: (mode: PermissionMode) => void
}) {
  const { t } = useLocale()
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const Icon = PERMISSION_ICONS[value]

  useEffect(() => {
    if (!open) return
    const items = menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitemradio']")
    const checked = menuRef.current?.querySelector<HTMLElement>("[aria-checked='true']")
    ;(checked ?? items?.[0])?.focus()
  }, [open])

  function close(): void {
    setOpen(false)
    buttonRef.current?.focus()
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape") {
      // 只收起权限列表，不关整个选择器。
      event.preventDefault()
      event.stopPropagation()
      event.nativeEvent.stopImmediatePropagation()
      close()
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitemradio']") ?? []),
    ]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const delta = event.key === "ArrowDown" ? 1 : -1
    items[(at + delta + items.length) % items.length]?.focus()
  }

  return (
    <div className="model-permission">
      <button
        ref={buttonRef}
        type="button"
        className="model-permission-btn"
        data-mode={value}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${t("composer.permission.title")} ${formatShortcut("Shift+Tab")}`}
        aria-label={`${t("composer.permission.title")}: ${t(permissionKeys[value].label)}`}
        onClick={() => setOpen((next) => !next)}
      >
        <Icon className="ic" aria-hidden="true" />
        <span className="truncate">{t(permissionKeys[value].label)}</span>
        <ChevronDown className="ic ic-sm chip-caret" aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={menuRef}
          className="model-permission-menu popup"
          role="menu"
          aria-label={t("composer.permission.title")}
          onKeyDown={onMenuKeyDown}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
          }}
        >
          {modes.map((mode) => {
            const ModeIcon = PERMISSION_ICONS[mode]
            return (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={mode === value}
                className={
                  mode === "danger-full-access"
                    ? "menu-item permission-item is-danger"
                    : "menu-item permission-item"
                }
                onClick={() => {
                  close()
                  onChange(mode)
                }}
              >
                <ModeIcon className="ic" aria-hidden="true" />
                <span className="grow">
                  <span>{t(permissionKeys[mode].label)}</span>
                  <span className="menu-item-desc">{t(permissionKeys[mode].description)}</span>
                </span>
                {mode === value ? <Check className="ic check-mark" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
