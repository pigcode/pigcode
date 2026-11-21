/** 定时任务页的「保持电脑唤醒」：和通用设置里的同一个开关，画成设置页那样的一行。 */
import { SettingRow, Switch, useLocale } from "@pigcode/ui-primitives"
import { usePreferences } from "./preferences"

export function KeepAwakeRow() {
  const { t } = useLocale()
  const [prefs, setPreference] = usePreferences()
  return (
    <div className="group schedules-awake">
      <SettingRow
        title={t("schedules.keepAwake.title")}
        description={t("schedules.keepAwake.hint")}
      >
        <Switch
          aria-label={t("schedules.keepAwake.title")}
          checked={prefs.keepAwake}
          onCheckedChange={(checked) => setPreference("keepAwake", checked)}
        />
      </SettingRow>
    </div>
  )
}
