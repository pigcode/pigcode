/**
 * 窗口底部的状态提示：操作失败的错误、Host 连不上时的说明，以及重连后的短提示。
 * 各处容器把失败写进 store.error，这里统一展示；不展示的话失败就悄无声息。
 */
import { useEffect, useState } from "react"
import { X } from "lucide-react"
import { useAppStore, type AppStore } from "@pigcode/client-runtime"
import { useLocale } from "@pigcode/ui-primitives"

/** 错误提示停留的时间；用户也可以手动关闭。 */
const ERROR_MS = 8000
/** 连接短暂抖动不提示，超过这个时间还没连上才显示。 */
const OFFLINE_GRACE_MS = 1500

/** 渲染状态提示。 */
export function ConnectionBanner({ store }: { store: AppStore }) {
  const state = useAppStore(store)
  const { t } = useLocale()
  const [offline, setOffline] = useState(false)

  useEffect(() => {
    if (!state.error) return undefined
    const timer = setTimeout(() => store.update({ error: null }), ERROR_MS)
    return () => clearTimeout(timer)
  }, [state.error, store])

  useEffect(() => {
    if (state.status === "connected") {
      setOffline(false)
      return undefined
    }
    const timer = setTimeout(() => setOffline(true), OFFLINE_GRACE_MS)
    return () => clearTimeout(timer)
  }, [state.status])

  if (!state.error && !offline && !state.reconnected) return null
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {offline ? (
        <div className="toast toast-warn">
          {state.status === "offline" ? t("status.offline") : t("status.connecting")}
        </div>
      ) : state.reconnected ? (
        <div className="toast">{t("status.reconnected")}</div>
      ) : null}
      {state.error ? (
        <div className="toast toast-error" role="alert">
          <span className="toast-text">{state.error}</span>
          <button
            type="button"
            className="toast-close"
            aria-label={t("status.dismiss")}
            onClick={() => store.update({ error: null })}
          >
            <X className="ic ic-sm" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
