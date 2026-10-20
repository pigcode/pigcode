/** 基于 Base UI Field 的表单字段组合。 */
import { Field as BaseField } from "@base-ui/react/field"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function FieldRoot({ className, ...props }: ComponentProps<typeof BaseField.Root>) {
  return <BaseField.Root className={cn("field", className)} {...props} />
}

export function FieldLabel({ className, ...props }: ComponentProps<typeof BaseField.Label>) {
  return <BaseField.Label className={cn("label", className)} {...props} />
}

export function FieldDescription({
  className,
  ...props
}: ComponentProps<typeof BaseField.Description>) {
  return <BaseField.Description className={cn("hint", className)} {...props} />
}

export function FieldError({ className, ...props }: ComponentProps<typeof BaseField.Error>) {
  return <BaseField.Error className={cn("error-text", className)} {...props} />
}

export function FieldControl({ className, ...props }: ComponentProps<typeof BaseField.Control>) {
  return <BaseField.Control className={cn("input", className)} {...props} />
}

/** 命名空间形式与 Base UI 的 Field.Root 等用法保持一致。 */
export const Field = {
  Root: FieldRoot,
  Label: FieldLabel,
  Description: FieldDescription,
  Error: FieldError,
  Control: FieldControl,
}
