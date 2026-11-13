/** 关闭有未保存修改的文件标签前的确认框。 */
import { Button, Dialog, useLocale } from "@pigcode/ui-primitives"

/** 关闭多个文件时在同一个对话框列出有草稿的文件。 */
export function DiscardDraftDialog({
  files,
  onCancel,
  onDiscard,
}: {
  files: string[] | null
  onCancel: () => void
  onDiscard: () => void
}) {
  const { t } = useLocale()
  return (
    <Dialog.Root
      open={files !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <Dialog.Content
        title={t("files.discard.title")}
        description={
          files && files.length > 1
            ? t("files.discard.multiple").replace("{files}", files.join(" · "))
            : t("files.discard.description").replace("{file}", files?.[0] ?? "")
        }
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
