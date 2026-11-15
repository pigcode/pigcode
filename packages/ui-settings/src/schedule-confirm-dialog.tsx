/** 删除任务和放弃修改共用的确认对话框。 */
import { Button, Dialog, useLocale } from "@pigcode/ui-primitives"

export function ScheduleConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel: string
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useLocale()
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Content
        className="schedule-confirm"
        title={title}
        description={description}
        closeLabel={t("common.close")}
      >
        <Dialog.Footer>
          <Dialog.Close render={<Button type="button" variant="ghost" />}>
            {t("schedules.cancel")}
          </Dialog.Close>
          <Button
            type="button"
            variant="solidDanger"
            onClick={() => {
              onClose()
              onConfirm()
            }}
          >
            {confirmLabel}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  )
}
