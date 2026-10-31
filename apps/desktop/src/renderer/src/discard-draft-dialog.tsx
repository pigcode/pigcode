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
      <Dialog.Content
        title={t("files.discard.title")}
        description={t("files.discard.description").replace("{file}", file ?? "")}
        closeLabel={t("common.close")}
      >
        <Dialog.Footer>
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("files.discard.cancel")}
          </Button>
          <Button type="button" variant="solidDanger" onClick={onDiscard}>
            {t("files.discard.confirm")}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  )
}
