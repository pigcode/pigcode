import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"
import { mobilePairingViewSchema, type MobilePairingView } from "@pigcode/contracts"
import { Button, SettingRow, SettingSection, useLocale } from "@pigcode/ui-primitives"
import type { CoreDeps } from "./chat-container"

export function PairingSettings({ deps, relayReady }: { deps: CoreDeps; relayReady: boolean }) {
  const { t } = useLocale()
  const { connection } = deps
  const [view, setView] = useState<MobilePairingView>()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState(false)
  const [qr, setQr] = useState<{ value: string; data: string | null }>()
  const attemptId = useRef<string | null>(null)
  const mounted = useRef(false)
  const revision = useRef(0)
  const pending = useRef(false)

  function acceptView(next: MobilePairingView) {
    attemptId.current = next.attempt?.id ?? null
    setView(next)
  }

  useEffect(() => {
    mounted.current = true
    let active = true
    function refresh() {
      if (pending.current) return
      const observed = revision.current
      void connection.call("mobile.pairing", {}).then(
        (response) => {
          if (!active || observed !== revision.current) return
          const parsed = mobilePairingViewSchema.safeParse(response)
          if (parsed.success) acceptView(parsed.data)
        },
        () => {},
      )
    }
    refresh()
    const timer = setInterval(refresh, 750)
    return () => {
      active = false
      mounted.current = false
      clearInterval(timer)
      const id = attemptId.current
      attemptId.current = null
      if (id) void connection.call("mobile.pairing.cancel", { id }).catch(() => {})
    }
  }, [connection])

  const qrValue = view?.attempt?.qr
  useEffect(() => {
    let active = true
    if (qrValue) {
      void QRCode.toDataURL(qrValue, { errorCorrectionLevel: "L", width: 280 }).then(
        (data) => {
          if (active) setQr({ value: qrValue, data })
        },
        () => {
          if (active) setQr({ value: qrValue, data: null })
        },
      )
    }
    return () => {
      active = false
    }
  }, [qrValue])

  async function change(operation: () => Promise<unknown>) {
    if (pending.current) return
    pending.current = true
    revision.current++
    setWorking(true)
    setError(false)
    try {
      const next = mobilePairingViewSchema.parse(await operation())
      if (mounted.current) acceptView(next)
      else if (next.attempt) {
        void connection.call("mobile.pairing.cancel", { id: next.attempt.id }).catch(() => {})
      }
    } catch {
      if (mounted.current) setError(true)
    } finally {
      revision.current++
      pending.current = false
      if (mounted.current) setWorking(false)
    }
  }

  const attempt = view?.attempt
  const candidate = attempt?.candidate
  const seconds = attempt ? Math.max(0, Math.ceil((attempt.expiresAt - Date.now()) / 1000)) : 0
  const remaining = String(Math.floor(seconds / 60)) + ":" + String(seconds % 60).padStart(2, "0")
  const qrMissing = qrValue && qr?.value === qrValue && !qr.data
  const status = error
    ? t("settings.mobileRelay.status.host-unavailable")
    : qrMissing
      ? t("settings.pairing.status.qr-unavailable")
      : view?.status && view.status !== "idle"
        ? t(`settings.pairing.status.${view.status}`)
        : undefined

  return (
    <>
      <SettingSection title={t("settings.pairing.title")}>
        <SettingRow title={t("settings.pairing.scan")} description={t("settings.pairing.sleep")}>
          <Button
            size="sm"
            disabled={!relayReady || working}
            onClick={() => void change(() => connection.call("mobile.pairing.start", {}))}
          >
            {t(
              attempt || view?.status === "expired"
                ? "settings.pairing.regenerate"
                : "settings.pairing.start",
            )}
          </Button>
        </SettingRow>
        {attempt && (
          <SettingRow
            title={t("settings.pairing.remaining")}
            description={<span className="mono">{remaining}</span>}
          >
            <Button
              size="sm"
              variant="ghost"
              disabled={working}
              onClick={() =>
                void change(() => connection.call("mobile.pairing.cancel", { id: attempt.id }))
              }
            >
              {t("settings.pairing.cancel")}
            </Button>
          </SettingRow>
        )}
        {qrValue && qr?.value === qrValue && qr.data && !candidate && (
          <SettingRow title={t("settings.pairing.qr")}>
            <img src={qr.data} width={280} height={280} alt={t("settings.pairing.qr")} />
          </SettingRow>
        )}
        {attempt && candidate && (
          <SettingRow
            title={candidate.name}
            description={<span className="mono">{candidate.code}</span>}
          >
            <Button
              size="sm"
              variant="primary"
              disabled={working || seconds === 0}
              onClick={() =>
                void change(() =>
                  connection.call("mobile.pairing.confirm", {
                    id: attempt.id,
                    confirmation: candidate.confirmation,
                  }),
                )
              }
            >
              {t("settings.pairing.allow")}
            </Button>
          </SettingRow>
        )}
        {status && <SettingRow title={<span role="status">{status}</span>} />}
      </SettingSection>
      <SettingSection title={t("settings.pairing.devices")}>
        {view?.devices.length ? (
          view.devices.map((device) => (
            <SettingRow
              key={device.id}
              title={device.name}
              description={[
                device.platform === "ios" ? "iOS" : "Android",
                new Date(device.lastConnectedAt).toLocaleString(),
              ].join(" · ")}
            >
              {t(device.connected ? "settings.pairing.online" : "settings.pairing.offline")}
            </SettingRow>
          ))
        ) : (
          <SettingRow title={t("settings.pairing.empty")} />
        )}
      </SettingSection>
    </>
  )
}
