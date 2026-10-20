/** 会话环境抽屉：只展示 provider、工作目录、模型与权限，不含账号或代理字段。 */
import { X } from "lucide-react"
import type { PermissionMode } from "@pigcode/contracts"
import { Button, useLocale, type MessageKey } from "@pigcode/ui-primitives"

/** 抽屉需要的会话环境数据。 */
export interface EnvironmentInfo {
  providerId: string
  cwd: string | undefined
  modelId: string | null
  permissionMode: PermissionMode
}

const PERMISSION_KEYS: Record<PermissionMode, MessageKey> = {
  "read-only": "chat.permission.readOnly",
  "workspace-write": "chat.permission.workspaceWrite",
  "danger-full-access": "chat.permission.dangerFullAccess",
  plan: "chat.permission.plan",
}

function EnvironmentItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="item">
      <div className="main">
        <div className="ttl">{label}</div>
        <div className="desc mono">{value}</div>
      </div>
    </div>
  )
}

/** 渲染右侧环境抽屉；关闭时不占用布局。 */
export function EnvironmentDrawer({
  open,
  info,
  onClose,
}: {
  open: boolean
  info: EnvironmentInfo
  onClose: () => void
}) {
  const { t } = useLocale()
  if (!open) return null

  return (
    <aside className="drawer" aria-label={t("chat.environment")}>
      <div className="drawer-head">
        <h2>{t("chat.environment")}</h2>
        <span className="grow" />
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={t("chat.environment.close")}
          onClick={onClose}
        >
          <X className="ic" aria-hidden="true" />
        </Button>
      </div>
      <div className="group">
        <EnvironmentItem label={t("chat.environment.provider")} value={info.providerId} />
        <EnvironmentItem
          label={t("chat.environment.cwd")}
          value={info.cwd ?? t("chat.environment.unknown")}
        />
        {info.modelId ? (
          <EnvironmentItem label={t("chat.environment.model")} value={info.modelId} />
        ) : null}
        <EnvironmentItem
          label={t("chat.environment.permission")}
          value={t(PERMISSION_KEYS[info.permissionMode])}
        />
      </div>
    </aside>
  )
}
