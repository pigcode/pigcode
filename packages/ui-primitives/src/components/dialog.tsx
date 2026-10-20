/** 基于 Base UI Dialog 的模态对话框。 */
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import type { ComponentProps } from "react"
import { cn } from "./cn"

/** 蒙层，沿用 scrim 语义类。 */
export function DialogBackdrop({
  className,
  ...props
}: ComponentProps<typeof BaseDialog.Backdrop>) {
  return <BaseDialog.Backdrop className={cn("scrim", className)} {...props} />
}

/** 对话框面板，沿用 dialog 语义类。 */
export function DialogPopup({ className, ...props }: ComponentProps<typeof BaseDialog.Popup>) {
  return <BaseDialog.Popup className={cn("dialog", className)} {...props} />
}

export const Dialog = {
  Root: BaseDialog.Root,
  Trigger: BaseDialog.Trigger,
  Portal: BaseDialog.Portal,
  Backdrop: DialogBackdrop,
  Popup: DialogPopup,
  Title: BaseDialog.Title,
  Description: BaseDialog.Description,
  Close: BaseDialog.Close,
}
