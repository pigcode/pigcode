/**
 * 页面区的几种状态：还没有页面、加载失败（证书问题单独说明怎么办）、页面进程崩溃。
 * webview 只在真正有页面时露出来；这几种状态下宿主把它藏起来，状态画在页面区里。
 */
import { Globe, RotateCw, TriangleAlert } from "lucide-react"
import { Button, useLocale } from "@pigcode/ui-primitives"

/** 主框架加载失败：Chromium 的错误码与说明，以及没打开的地址。 */
export interface BrowserLoadError {
  code: number
  description: string
  url: string
}

/** 页面进程意外退出的原因（crashed、oom、killed 等）。 */
export interface BrowserCrash {
  reason: string
}

/** Chromium 的证书错误码在 -200 到 -299 之间。 */
export function isCertificateError(code: number): boolean {
  return code <= -200 && code > -300
}

export function BrowserEmptyState() {
  const { t } = useLocale()
  return (
    <div className="browser-state" data-state="empty">
      <Globe className="browser-state-icon" aria-hidden="true" />
      <h3>{t("browser.title")}</h3>
      <p>{t("browser.emptyHint")}</p>
    </div>
  )
}

export function BrowserLoadErrorState({
  error,
  onRetry,
}: {
  error: BrowserLoadError
  onRetry: () => void
}) {
  const { t } = useLocale()
  const certificate = isCertificateError(error.code)
  return (
    <div className="browser-state" data-state="error" role="alert">
      <TriangleAlert className="browser-state-icon" aria-hidden="true" />
      <h3>{certificate ? t("browser.loadError.certTitle") : t("browser.loadError.title")}</h3>
      <p className="browser-state-detail">
        {error.description || String(error.code)}
        {error.url ? (
          <>
            <br />
            {error.url}
          </>
        ) : null}
      </p>
      {certificate ? <p>{t("browser.loadError.certHint")}</p> : null}
      <Button type="button" size="sm" onClick={onRetry}>
        <RotateCw className="ic ic-sm" aria-hidden="true" />
        {t("browser.retry")}
      </Button>
    </div>
  )
}

export function BrowserCrashState({
  crash,
  onRetry,
}: {
  crash: BrowserCrash
  onRetry: () => void
}) {
  const { t } = useLocale()
  return (
    <div className="browser-state" data-state="crashed" role="alert">
      <TriangleAlert className="browser-state-icon" aria-hidden="true" />
      <h3>{t("browser.crashed.title")}</h3>
      <p>{t("browser.crashed.hint").replace("{reason}", crash.reason)}</p>
      <Button type="button" size="sm" onClick={onRetry}>
        <RotateCw className="ic ic-sm" aria-hidden="true" />
        {t("browser.retry")}
      </Button>
    </div>
  )
}
