/** 连接恢复后的短提示；Host 被杀后由 main 重新转交端口触发。 */
import { useAppStore, type AppStore } from "@pigcode/client-runtime"
import { useLocale } from "@pigcode/ui-primitives"

/** 仅在发生过重连时渲染 toast。 */
export function ConnectionBanner({ store }: { store: AppStore }) {
  const state = useAppStore(store)
  const { t } = useLocale()
  if (!state.reconnected) return null
  return (
    <div className="toast-stack" role="status" aria-live="polite">
      <div className="toast">{t("status.reconnected")}</div>
    </div>
  )
}
