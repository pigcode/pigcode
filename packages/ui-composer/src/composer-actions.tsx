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
  allowQueue = false,
  canInterrupt,
  formLabel,
  disabled,
  onSubmit,
  onStop,
}: {
  running: boolean
  allowQueue?: boolean
  canInterrupt: boolean
  formLabel: string | undefined
  disabled: boolean
  onSubmit: () => void
  onStop: () => void
}) {
  const { t } = useLocale()
  const sendLabel = formLabel ?? t("chat.send")
  return (
    <>
      {running && canInterrupt ? (
        <Button
          variant="plain"
          className="send is-stop"
          type="button"
          aria-label={t("chat.interrupt")}
          title={t("chat.interrupt")}
          onClick={onStop}
        >
          <Square className="ic" aria-hidden="true" />
        </Button>
      ) : null}
      {!running || (allowQueue && !disabled) ? (
        <Button
          variant="plain"
          className="send"
          type="button"
          data-form-action={formLabel ? "" : undefined}
          aria-label={sendLabel}
          title={formLabel ? `${sendLabel} · ${formatShortcut("Mod+Enter")}` : sendLabel}
          disabled={formLabel ? disabled : undefined}
          aria-disabled={disabled ? true : undefined}
          onClick={onSubmit}
        >
          {formLabel ?? <ArrowUp className="ic" aria-hidden="true" />}
        </Button>
      ) : null}
    </>
  )
}
