/**
 * 权限模式：图标、开启完全访问前的确认框，以及没有模型选择器时单独显示的权限胶囊。
 * 有模型选择器时，权限在选择器底栏里切换，确认框仍由这里给出。
 */
import { useState, type ReactNode } from "react"
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

/** 各权限模式的图标；胶囊、选择器底栏与菜单共用。 */
export const PERMISSION_ICONS: Record<PermissionMode, LucideIcon> = {
  "workspace-write": Hand,
  plan: ListChecks,
  "read-only": Eye,
  "danger-full-access": ShieldAlert,
}

/**
 * 切换权限的入口：完全访问先弹确认框，确认后才调用 onChange。
 * 返回的 dialog 要渲染在弹层之外，弹层关掉后确认框还在。
 */
export function usePermissionChange(
  value: PermissionMode,
  onChange: ((mode: PermissionMode) => void) | undefined,
): { request: (mode: PermissionMode) => void; dialog: ReactNode } {
  const { t } = useLocale()
  const [confirming, setConfirming] = useState(false)

  function request(mode: PermissionMode): void {
    if (mode === value) return
    if (mode === "danger-full-access") {
      setConfirming(true)
      return
    }
    onChange?.(mode)
  }

  const dialog = (
    <Dialog.Root open={confirming} onOpenChange={setConfirming}>
      <Dialog.Content
        title={t("composer.permission.full.confirmTitle")}
        description={t("composer.permission.full.confirmText")}
        closeLabel={t("common.close")}
      >
        <Dialog.Footer>
          <Dialog.Close render={<Button variant="ghost" />}>{t("common.cancel")}</Dialog.Close>
          <Button
            variant="solidDanger"
            onClick={() => {
              setConfirming(false)
              onChange?.("danger-full-access")
            }}
          >
            {t("composer.permission.full.confirm")}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  )
  return { request, dialog }
}

/** 权限菜单的属性。 */
export interface PermissionMenuProps {
  value: PermissionMode
  modes: readonly PermissionMode[]
  onChange?: ((mode: PermissionMode) => void) | undefined
  side?: "top" | "bottom"
}

/** 单独的权限胶囊：没有可选 Agent（也就没有模型选择器）时显示；完全访问时胶囊变成警示色。 */
export function PermissionMenu({ value, modes, onChange, side = "top" }: PermissionMenuProps) {
  const { t } = useLocale()
  const { request, dialog } = usePermissionChange(value, onChange)
  const Icon = PERMISSION_ICONS[value]

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
          <Menu.Positioner side={side} align="start" sideOffset={8}>
            <Menu.Popup className="permission-menu">
              {modes.map((mode) => {
                const ModeIcon = PERMISSION_ICONS[mode]
                return (
                  <Menu.Item
                    key={mode}
                    className={
                      mode === "danger-full-access"
                        ? "permission-item is-danger"
                        : "permission-item"
                    }
                    onClick={() => request(mode)}
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
      {dialog}
    </>
  )
}
