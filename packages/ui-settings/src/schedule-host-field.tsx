/** 定时任务编辑器里的「执行主机」选择与只读标识字段。 */
import type { HostSummary } from "@pigcode/contracts"
import { HostBadge, HostPickerMenu, useLocale } from "@pigcode/ui-primitives"

export function ScheduleHostField({
  isEditing,
  hosts,
  targetHostId,
  scheduleHost,
  hostOffline,
  saving,
  onSelectHost,
}: {
  isEditing: boolean
  hosts?: readonly HostSummary[] | undefined
  targetHostId?: string | undefined
  scheduleHost?: HostSummary | undefined
  hostOffline: boolean
  saving: boolean
  onSelectHost?: ((hostId: string) => void) | undefined
}) {
  const { t } = useLocale()
  if (!hosts || hosts.length < 2) return null

  if (!isEditing && targetHostId && onSelectHost) {
    return (
      <div className="field">
        <span className="label">{t("hosts.targetHost")}</span>
        <div>
          <HostPickerMenu
            hosts={hosts}
            value={targetHostId}
            onlineOnly
            disabled={saving}
            onChange={onSelectHost}
          />
        </div>
      </div>
    )
  }

  if (isEditing && scheduleHost) {
    return (
      <div className="field">
        <span className="label">{t("hosts.targetHost")}</span>
        <div>
          <HostBadge host={scheduleHost} showOffline={hostOffline} />
        </div>
      </div>
    )
  }

  return null
}
