import { useEffect, useId, useState, type FormEvent } from "react"
import { useAppStore } from "@pigcode/client-runtime"
import {
  relaySettingsSchema,
  relayTestResultSchema,
  type RelaySettingsView,
  type RelayTestResult,
} from "@pigcode/contracts"
import {
  Button,
  Input,
  SettingPage,
  SettingRow,
  SettingSection,
  useLocale,
} from "@pigcode/ui-primitives"
import { PairingSettings } from "./pairing-settings"
import type { CoreDeps } from "./chat-container"

type Status = RelayTestResult["status"] | "host-unavailable"

export function RelaySettingsPage({ deps }: { deps: CoreDeps }) {
  const { t } = useLocale()
  const addressId = useId()
  const tokenId = useId()
  const connected = useAppStore(deps.store).status === "connected"
  const { connection } = deps
  const [saved, setSaved] = useState<RelaySettingsView | null>(null)
  const [draftAddress, setDraftAddress] = useState<string | null>(null)
  const [token, setToken] = useState("")
  const [checking, setChecking] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const address = draftAddress ?? saved?.address ?? ""
  const canReuseToken = saved?.tokenConfigured && saved.address === address
  const disabled = checking || !connected

  useEffect(() => {
    if (!connected) return
    let active = true
    void connection.call("relay.settings", {}).then(
      (value) => {
        const settings = relaySettingsSchema.safeParse(value)
        if (active && settings.success) setSaved(settings.data)
      },
      () => {
        if (active) setStatus("host-unavailable")
      },
    )
    return () => {
      active = false
    }
  }, [connection, connected])

  async function testAndSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled) return
    setChecking(true)
    setStatus(null)
    try {
      const value = await connection.call("relay.testAndSave", { address, token })
      const result = relayTestResultSchema.parse(value)
      setStatus(result.status)
      if (result.status === "saved") {
        setSaved(result.settings)
        setDraftAddress(null)
        setToken("")
      }
    } catch {
      setStatus("host-unavailable")
    } finally {
      setChecking(false)
    }
  }

  return (
    <SettingPage title={t("settings.mobileRelay")}>
      <form onSubmit={(event) => void testAndSave(event)}>
        <SettingSection title={t("settings.mobileRelay.relay")}>
          <SettingRow
            title={<label htmlFor={addressId}>{t("settings.mobileRelay.address")}</label>}
          >
            <Input
              id={addressId}
              className="mono"
              placeholder="wss://relay.example.com"
              autoComplete="off"
              spellCheck={false}
              value={address}
              disabled={disabled}
              onChange={(event) => setDraftAddress(event.target.value)}
            />
          </SettingRow>
          <SettingRow title={<label htmlFor={tokenId}>{t("settings.mobileRelay.token")}</label>}>
            <Input
              id={tokenId}
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={token}
              placeholder={canReuseToken ? t("settings.mobileRelay.configured") : undefined}
              disabled={disabled}
              onChange={(event) => setToken(event.target.value)}
            />
          </SettingRow>
          <SettingRow
            title={t("settings.mobileRelay.check")}
            description={
              <span role="status">
                {checking
                  ? t("settings.mobileRelay.checking")
                  : status
                    ? t(`settings.mobileRelay.status.${status}`)
                    : undefined}
              </span>
            }
          >
            <Button type="submit" disabled={disabled}>
              {t("settings.mobileRelay.testAndSave")}
            </Button>
          </SettingRow>
        </SettingSection>
      </form>
      <PairingSettings deps={deps} relayReady={Boolean(saved?.tokenConfigured)} />
    </SettingPage>
  )
}
