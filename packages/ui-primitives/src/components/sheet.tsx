/** 基于 Base UI Dialog 的侧边抽屉。 */
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import type { ComponentProps } from "react"
import { cn } from "./cn"

/** 抽屉从哪一侧滑入。 */
export type SheetSide = "left" | "right"

export interface SheetPopupProps extends ComponentProps<typeof BaseDialog.Popup> {
  /** 默认从右侧滑入。 */
  side?: SheetSide
}

/** 蒙层，沿用 scrim 语义类。 */
export function SheetBackdrop({ className, ...props }: ComponentProps<typeof BaseDialog.Backdrop>) {
  return <BaseDialog.Backdrop className={cn("scrim", className)} {...props} />
}

/** 抽屉面板，追加 sheet 与左右方向的变体类。 */
export function SheetPopup({ className, side = "right", ...props }: SheetPopupProps) {
  return (
    <BaseDialog.Popup
      className={cn("dialog", "sheet", side === "left" ? "sheet-left" : "sheet-right", className)}
      {...props}
    />
  )
}

export const Sheet = {
  Root: BaseDialog.Root,
  Trigger: BaseDialog.Trigger,
  Portal: BaseDialog.Portal,
  Backdrop: SheetBackdrop,
  Popup: SheetPopup,
  Title: BaseDialog.Title,
  Description: BaseDialog.Description,
  Close: BaseDialog.Close,
}
