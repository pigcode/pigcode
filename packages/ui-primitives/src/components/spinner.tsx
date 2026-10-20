/** 纯样式加载指示器；可见文案由调用方通过 aria-label 传入并本地化。 */
import { Loader2Icon } from "lucide-react"
import type { ComponentProps } from "react"
import { cn } from "./cn"

export function Spinner({ className, ...props }: ComponentProps<typeof Loader2Icon>) {
  return <Loader2Icon role="status" className={cn("spin", className)} {...props} />
}
