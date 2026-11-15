/** 平台提供统一权限选项；扩大权限的确认框保留在模型浮层之外。 */
import { useState, type ReactNode } from "react"
import { Check, ChevronDown } from "lucide-react"
import type { AgentPermissionMode } from "@pigcode/contracts"
import { Button, Dialog, Menu, formatShortcut, useLocale } from "@pigcode/ui-primitives"
import {
  permissionDescription,
  permissionIcon,
  permissionLabel,
  permissionNeedsConfirmation,
} from "./permission-options"

export function usePermissionChange(
  value: string,
  modes: readonly AgentPermissionMode[],
  onChange: ((mode: string) => void) | undefined,
): {
  request: (mode: string) => void
  dialog: ReactNode
} {
  const { t, locale } = useLocale()
  const [confirming, setConfirming] = useState<AgentPermissionMode | null>(null)
  function request(id: string) {
    if (id === value) return
    const mode = modes.find((mode) => mode.id === id)
    if (!mode) return
    if (permissionNeedsConfirmation(mode)) setConfirming(mode)
    else onChange?.(id)
  }
  return {
    request,
    dialog: (
      <Dialog.Root
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      >
        <Dialog.Content
          title={t("composer.permission.confirmTitle").replace(
            "{mode}",
            permissionLabel(confirming ?? undefined, locale),
          )}
          description={confirming ? permissionDescription(confirming, locale) : ""}
          closeLabel={t("common.close")}
        >
          <Dialog.Footer>
            <Dialog.Close render={<Button variant="ghost" />}>{t("common.cancel")}</Dialog.Close>
            <Button
              variant="solidDanger"
              onClick={() => {
                if (confirming) onChange?.(confirming.id)
                setConfirming(null)
              }}
            >
              {t("composer.permission.confirm").replace(
                "{mode}",
                permissionLabel(confirming ?? undefined, locale),
              )}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    ),
  }
}

export interface PermissionMenuProps {
  value: string
  modes: readonly AgentPermissionMode[]
  onChange?: ((mode: string) => void) | undefined
  side?: "top" | "bottom"
}

export function PermissionMenu({ value, modes, onChange, side = "top" }: PermissionMenuProps) {
  const { t, locale } = useLocale()
  const { request, dialog } = usePermissionChange(value, modes, onChange)
  const selected = modes.find((mode) => mode.id === value)
  const Icon = permissionIcon(selected)
  if (!modes.length) return null
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className="chip-btn permission-chip"
          type="button"
          data-mode={value}
          data-elevated={(selected && permissionNeedsConfirmation(selected)) || undefined}
          title={`${t("composer.permission.title")} ${formatShortcut("Shift+Tab")}`}
          aria-label={`${t("composer.permission.title")}: ${permissionLabel(selected, locale)}`}
          disabled={!onChange}
        >
          <Icon className="ic" aria-hidden="true" />
          <span className="chip-label-optional">{permissionLabel(selected, locale)}</span>
          <ChevronDown className="ic chip-caret" aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side={side} align="start" sideOffset={8}>
            <Menu.Popup className="permission-menu">
              {modes.map((mode) => {
                const ModeIcon = permissionIcon(mode)
                return (
                  <Menu.Item
                    key={mode.id}
                    className={
                      permissionNeedsConfirmation(mode)
                        ? "permission-item is-danger"
                        : "permission-item"
                    }
                    onClick={() => request(mode.id)}
                  >
                    <ModeIcon className="ic" aria-hidden="true" />
                    <span className="grow">
                      <span>{permissionLabel(mode, locale)}</span>
                      <span className="menu-item-desc">{permissionDescription(mode, locale)}</span>
                    </span>
                    {mode.id === value ? (
                      <Check className="ic check-mark" aria-hidden="true" />
                    ) : null}
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
