/**
 * 基于 Base UI Dialog 的模态对话框。所有对话框同一种结构：
 * 标题与关闭按钮一行，标题下面可选一行说明，然后是正文和右对齐的底部按钮（取消在左、确认在右）。
 * 蒙层、居中、Esc 关闭都由 Dialog.Content 负责，样式见 dialogs.css。
 */
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import { X } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"
import { withBaseClass } from "./base-class"
import { cn } from "./cn"

export interface DialogContentProps extends Omit<
  ComponentProps<typeof BaseDialog.Popup>,
  "title" | "children"
> {
  title: ReactNode
  /** 标题下面的一行说明。 */
  description?: ReactNode | undefined
  /** 右上角关闭按钮的无障碍名称。 */
  closeLabel: string
  /** 正在提交、不能关闭时禁用右上角的关闭按钮。 */
  closeDisabled?: boolean | undefined
  children?: ReactNode
}

/** 蒙层、面板、标题行与关闭按钮；children 放 Dialog.Body 与 Dialog.Footer（可以包在 form 里）。 */
function Content({
  title,
  description,
  closeLabel,
  closeDisabled,
  className,
  children,
  ...props
}: DialogContentProps) {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className="scrim" />
      <BaseDialog.Popup className={withBaseClass("dialog", className)} {...props}>
        <div className="dialog-head">
          <div className="dialog-heading">
            <BaseDialog.Title className="dialog-title">{title}</BaseDialog.Title>
            {description ? (
              <BaseDialog.Description className="dialog-desc">{description}</BaseDialog.Description>
            ) : null}
          </div>
          <BaseDialog.Close
            className="icon-btn dialog-close"
            aria-label={closeLabel}
            title={closeLabel}
            disabled={closeDisabled}
          >
            <X className="ic" aria-hidden="true" />
          </BaseDialog.Close>
        </div>
        {children}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  )
}

/** 正文：表单字段、提示一类内容，竖向排列。 */
function Body({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("dialog-body", className)} {...props} />
}

/** 底部按钮区：取消放前面、确认放后面，靠右排列。 */
function Footer({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("dialog-foot", className)} {...props} />
}

export const Dialog = {
  Root: BaseDialog.Root,
  Trigger: BaseDialog.Trigger,
  Content,
  Body,
  Footer,
  /** 关闭对话框的按钮，比如底部的「取消」。 */
  Close: BaseDialog.Close,
}
