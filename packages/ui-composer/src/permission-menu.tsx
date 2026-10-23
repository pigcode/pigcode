/** 权限模式的胶囊与菜单；完全访问需要在确认框里再点一次才会开启。 */
import { useState, type CSSProperties } from "react"
import {
  Check,
  ChevronDown,
  Eye,
  Hand,
  ListChecks,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react"
import { Button, Dialog, Menu, formatShortcut, useLocale } from "@pigcode/ui-primitives"
import { permissionKeys, type PermissionMode } from "./composer-options"

const ICONS: Record<PermissionMode, LucideIcon> = {
  "workspace-write": Hand,
  plan: ListChecks,
  "read-only": Eye,
  "danger-full-access": ShieldAlert,
}

const centered: CSSProperties = {
  position: "fixed",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  zIndex: 90,
}

/** 权限菜单的属性。 */
export interface PermissionMenuProps {
  value: PermissionMode
  modes: readonly PermissionMode[]
  onChange?: ((mode: PermissionMode) => void) | undefined
  side?: "top" | "bottom"
}

/** 画出权限胶囊；完全访问时胶囊变成警示色。 */
export function PermissionMenu({ value, modes, onChange, side = "top" }: PermissionMenuProps) {
  const { t } = useLocale()
  const [confirming, setConfirming] = useState(false)
  const Icon = ICONS[value]

  function pick(mode: PermissionMode): void {
    if (mode === value) return
    if (mode === "danger-full-access") {
      setConfirming(true)
      return
    }
    onChange?.(mode)
  }

  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className="chip-btn permission-chip"
          type="button"
          data-mode={value}
          title={`${t("composer.permission.title")} ${formatShortcut("Shift+Tab")}`}
          aria-label={`${t("composer.permission.title")}: ${t(permissionKeys[value].label)}`}
          disabled={!onChange}
        >
          <Icon className="ic" aria-hidden="true" />
          <span className="chip-label-optional">{t(permissionKeys[value].label)}</span>
          <ChevronDown className="ic chip-caret" aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner className="menu-positioner" side={side} align="start" sideOffset={8}>
            <Menu.Popup className="menu-popup permission-menu">
              {modes.map((mode) => {
                const ModeIcon = ICONS[mode]
                return (
                  <Menu.Item
                    key={mode}
                    className={
                      mode === "danger-full-access"
                        ? "menu-item permission-item is-danger"
                        : "menu-item permission-item"
                    }
                    onClick={() => pick(mode)}
                  >
                    <ModeIcon className="ic" aria-hidden="true" />
                    <span className="grow">
                      <span>{t(permissionKeys[mode].label)}</span>
                      <span className="menu-item-desc">{t(permissionKeys[mode].description)}</span>
                    </span>
                    {mode === value ? <Check className="ic check-mark" aria-hidden="true" /> : null}
                  </Menu.Item>
                )
              })}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Dialog.Root open={confirming} onOpenChange={setConfirming}>
        <Dialog.Portal>
          <Dialog.Backdrop className="confirm-scrim" />
          <Dialog.Popup className="confirm-dialog" style={centered}>
            <div className="confirm-icon" aria-hidden="true">
              <ShieldAlert className="ic" />
            </div>
            <Dialog.Title className="confirm-title">
              {t("composer.permission.full.confirmTitle")}
            </Dialog.Title>
            <Dialog.Description className="confirm-text">
              {t("composer.permission.full.confirmText")}
            </Dialog.Description>
            <div className="confirm-actions">
              <Dialog.Close render={<Button variant="secondary" size="sm" />}>
                {t("common.cancel")}
              </Dialog.Close>
              <Button
                variant="solidDanger"
                size="sm"
                onClick={() => {
                  setConfirming(false)
                  onChange?.("danger-full-access")
                }}
              >
                {t("composer.permission.full.confirm")}
              </Button>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
