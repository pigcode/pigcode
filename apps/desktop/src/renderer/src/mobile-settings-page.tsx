/**
 * 「手机端」独立设置页（参照 Orca 手机端/远程主机分离设计）：
 * 专责本机作为服务端时面向 iOS / Android App 的扫码配对、推送与本机开发服预览。
 */
import { useEffect, useState } from "react"
import { relaySettingsSchema } from "@pigcode/contracts"
import { useAppStore } from "@pigcode/client-runtime"
import { SettingPage, SettingRow, SettingSection, useLocale } from "@pigcode/ui-primitives"
import { PairingSettings } from "./pairing-settings"
import type { CoreDeps } from "./chat-container"

export function MobileSettingsPage({ deps }: { deps: CoreDeps }) {
  const { t } = useLocale()
  const connected = useAppStore(deps.store).status === "connected"
  const [relayReady, setRelayReady] = useState(false)

  useEffect(() => {
    if (!connected) {
      setRelayReady(false)
      return
    }
    let active = true
    void deps.connection
      .call("relay.settings", {})
      .then((raw) => {
        if (!active) return
        const parsed = relaySettingsSchema.safeParse(raw)
        setRelayReady(parsed.success ? Boolean(parsed.data.tokenConfigured) : false)
      })
      .catch(() => {
        if (active) setRelayReady(false)
      })
    return () => {
      active = false
    }
  }, [deps.connection, connected])

  return (
    <SettingPage title={t("settings.mobile.pageTitle")} sub={t("settings.mobile.subtitle")}>
      <PairingSettings deps={deps} relayReady={relayReady} />
      <SettingSection>
        <SettingRow title={t("settings.mobile.headlessNote")} />
      </SettingSection>
    </SettingPage>
  )
}
