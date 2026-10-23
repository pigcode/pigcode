/** 关闭有未保存修改的文件标签前的确认框。 */
import { Button, Dialog, useLocale } from "@pigcode/ui-primitives"

/** file 为 null 时不显示。 */
export function DiscardDraftDialog({
  file,
  onCancel,
  onDiscard,
}: {
  file: string | null
  onCancel: () => void
  onDiscard: () => void
}) {
  const { t } = useLocale()
  return (
    <Dialog.Root
      open={file !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className="discard-dialog">
          <Dialog.Title className="discard-dialog-title">{t("files.discard.title")}</Dialog.Title>
          <Dialog.Description className="discard-dialog-text">
            {t("files.discard.description").replace("{file}", file ?? "")}
          </Dialog.Description>
          <div className="discard-dialog-actions">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t("files.discard.cancel")}
            </Button>
            <Button type="button" variant="solidDanger" onClick={onDiscard}>
              {t("files.discard.confirm")}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
