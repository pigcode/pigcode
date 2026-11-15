/** Composer 工具栏的添加内容与提交动作。 */
import { ArrowUp, AtSign, Plus, Slash, Square } from "lucide-react"
import { Button, Menu, formatShortcut, useLocale } from "@pigcode/ui-primitives"

export function ComposerAttachMenu({
  empty,
  disabled,
  side,
  onTrigger,
}: {
  empty: boolean
  disabled: boolean
  side: "top" | "bottom"
  onTrigger: (character: "@" | "/") => void
}) {
  const { t } = useLocale()
  return (
    <Menu.Root>
      <Menu.Trigger
        className="icon-btn composer-attach"
        type="button"
        aria-label={t("composer.attach")}
        title={t("composer.attach")}
        disabled={disabled}
      >
        <Plus className="ic" aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side={side} align="start" sideOffset={8}>
          <Menu.Popup>
            <Menu.Item onClick={() => onTrigger("@")}>
              <AtSign className="ic" aria-hidden="true" />
              <span className="grow">{t("composer.attach.file")}</span>
              <span className="menu-meta">@</span>
            </Menu.Item>
            <Menu.Item disabled={!empty} onClick={() => onTrigger("/")}>
              <Slash className="ic" aria-hidden="true" />
              <span className="grow">{t("composer.attach.command")}</span>
              <span className="menu-meta">/</span>
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

export function ComposerSubmit({
  running,
  canInterrupt,
  formLabel,
  disabled,
  onSubmit,
  onStop,
}: {
  running: boolean
  canInterrupt: boolean
  formLabel: string | undefined
  disabled: boolean
  onSubmit: () => void
  onStop: () => void
}) {
  const { t } = useLocale()
  if (running && !canInterrupt) return null
  const label = running ? t("chat.interrupt") : (formLabel ?? t("chat.send"))
  return (
    <Button
      variant="plain"
      className={running ? "send is-stop" : "send"}
      type="button"
      data-form-action={formLabel ? "" : undefined}
      aria-label={label}
      title={formLabel ? `${label} · ${formatShortcut("Mod+Enter")}` : label}
      disabled={formLabel ? disabled : undefined}
      aria-disabled={!running && disabled ? true : undefined}
      onClick={running ? onStop : onSubmit}
    >
      {running ? (
        <Square className="ic" aria-hidden="true" />
      ) : (
        (formLabel ?? <ArrowUp className="ic" aria-hidden="true" />)
      )}
    </Button>
  )
}
