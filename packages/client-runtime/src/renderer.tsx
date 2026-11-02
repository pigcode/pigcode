/** 应用渲染器：统一挂载 locale、tooltip、toast 与窗口外壳。 */
import { LocaleProvider, Tooltip, type Locale } from "@pigcode/ui-primitives"
import { Shell, ToastProvider, type ShellProps } from "@pigcode/ui-shell"

/** AppRenderer 在外壳 props 之上增加当前语言。 */
export interface AppRendererProps extends ShellProps {
  locale: Locale
}

/** 组合全局 context（LocaleProvider、Tooltip.Provider、ToastProvider）与 Shell；具体页面由调用方通过 children 注入。 */
export function AppRenderer({ locale, ...shellProps }: AppRendererProps) {
  return (
    <LocaleProvider locale={locale}>
      <Tooltip.Provider>
        <ToastProvider>
          <Shell {...shellProps} />
        </ToastProvider>
      </Tooltip.Provider>
    </LocaleProvider>
  )
}
