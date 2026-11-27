/**
 * 窗口底部的状态提示：操作失败的错误、Host 连不上时的说明，以及重连后的短提示。
 * 各处容器把失败写进 store.error，这里统一展示；不展示的话失败就悄无声息。
 */
import { useEffect, useState } from "react"
import { X } from "lucide-react"
import { HOST_LOCAL_ID, type HostSummary } from "@pigcode/contracts"
import { useAppStore, type AppStore } from "@pigcode/client-runtime"
import { Button, hostDisplayName, useLocale } from "@pigcode/ui-primitives"

/** 错误提示停留的时间；用户也可以手动关闭。 */
const ERROR_MS = 8000
/** 连接短暂抖动不提示，超过这个时间还没连上才显示。 */
const OFFLINE_GRACE_MS = 1500

/** 渲染状态提示。 */
export function ConnectionBanner({
  store,
  activeHost,
  onReconnectHost,
}: {
  store: AppStore
  activeHost?: HostSummary | undefined
  onReconnectHost?: ((hostId: string) => void) | undefined
}) {
  const state = useAppStore(store)
  const { t } = useLocale()
  const [offline, setOffline] = useState(false)
  const isRemote = Boolean(activeHost && activeHost.id !== HOST_LOCAL_ID)

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

  const remoteOffline = isRemote && activeHost && activeHost.status !== "connected"
  if (!state.error && !offline && !state.reconnected && !remoteOffline) return null
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {remoteOffline && activeHost ? (
        <div className="toast toast-warn">
          <span>
            {`${hostDisplayName(activeHost, t("hosts.remoteTag"))} · ${t("hosts.offlineReadonlyHint")}`}
          </span>
          {onReconnectHost ? (
            <Button size="sm" variant="ghost" onClick={() => onReconnectHost(activeHost.id)}>
              {t("hosts.reconnect")}
            </Button>
          ) : null}
        </div>
      ) : offline ? (
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
