import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"
import {
  mobilePairingViewSchema,
  mobilePreviewSettingsSchema,
  mobileRevokeResultSchema,
  type MobilePairingView,
  type MobileRevokeResult,
} from "@pigcode/contracts"
import {
  Button,
  Dialog,
  SettingRow,
  SettingSection,
  Switch,
  useLocale,
} from "@pigcode/ui-primitives"
import type { CoreDeps } from "./chat-container"

function deviceNumber(id: string): string {
  return id.slice(0, 8).toUpperCase()
}

export function PairingSettings({ deps, relayReady }: { deps: CoreDeps; relayReady: boolean }) {
  const { t } = useLocale()
  const { connection } = deps
  const [view, setView] = useState<MobilePairingView>()
  const [working, setWorking] = useState(false)
  const [error, setError] = useState(false)
  const [revoking, setRevoking] = useState<MobilePairingView["devices"][number] | null>(null)
  const [revokeStatus, setRevokeStatus] = useState<MobileRevokeResult["status"]>()
  const [qr, setQr] = useState<{ value: string; data: string | null }>()
  const [previewEnabled, setPreviewEnabled] = useState<boolean | null>(null)
  const [previewSaving, setPreviewSaving] = useState(false)
  const [previewError, setPreviewError] = useState(false)
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

  useEffect(() => {
    let active = true
    void connection.call("mobile.preview.getSettings", {}).then(
      (response) => {
        if (!active) return
        const parsed = mobilePreviewSettingsSchema.safeParse(response)
        if (parsed.success) {
          setPreviewEnabled(parsed.data.enabled)
          setPreviewError(false)
        } else {
          setPreviewError(true)
        }
      },
      () => {
        if (active) setPreviewError(true)
      },
    )
    return () => {
      active = false
    }
  }, [connection])

  async function togglePreviewEnabled(next: boolean) {
    if (previewSaving) return
    setPreviewSaving(true)
    setPreviewError(false)
    try {
      const response = mobilePreviewSettingsSchema.parse(
        await connection.call("mobile.preview.setEnabled", { enabled: next }),
      )
      if (mounted.current) setPreviewEnabled(response.enabled)
    } catch {
      if (mounted.current) setPreviewError(true)
    } finally {
      if (mounted.current) setPreviewSaving(false)
    }
  }

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

  function dismissRevoke() {
    setRevoking(null)
    setError(false)
    setRevokeStatus(undefined)
  }

  function revokeDevice() {
    if (!revoking) return
    const { id } = revoking
    void change(async () => {
      const result = mobileRevokeResultSchema.parse(
        await connection.call("mobile.devices.revoke", { deviceId: id }),
      )
      if (mounted.current) {
        setRevokeStatus(result.status)
        if (result.status !== "storage-unavailable") setRevoking(null)
      }
      return result.pairing
    })
  }

  const needsRelayUpdate = view?.devices.some((device) => device.needsRelayUpdate)
  const attempt = view?.attempt
  const candidate = attempt?.candidate
  const seconds = attempt ? Math.max(0, Math.ceil((attempt.expiresAt - Date.now()) / 1000)) : 0
  const remaining = String(Math.floor(seconds / 60)) + ":" + String(seconds % 60).padStart(2, "0")
  const qrMissing = qrValue && qr?.value === qrValue && !qr.data
  const status =
    error && !revoking
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
                : needsRelayUpdate
                  ? "settings.pairing.updateQr"
                  : "settings.pairing.start",
            )}
          </Button>
        </SettingRow>
        {needsRelayUpdate && <SettingRow title={t("settings.pairing.relayChanged")} />}
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
              {t(
                candidate.mode === "update"
                  ? "settings.pairing.updateAllow"
                  : "settings.pairing.allow",
              )}
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
                t("settings.pairing.deviceNumber").replace("{number}", deviceNumber(device.id)),
                device.lastConnectedAt === null
                  ? t("settings.pairing.neverConnected")
                  : t("settings.pairing.lastConnected").replace(
                      "{time}",
                      new Date(device.lastConnectedAt).toLocaleString(),
                    ),
                device.needsRelayUpdate ? t("settings.pairing.updatePending") : undefined,
                t(device.pushRegistered ? "settings.pairing.pushRegistered" : "settings.pairing.pushUnregistered"),
                device.reminders
                  ? t("settings.pairing.remindersSynced").replace("{time}", new Date(device.reminders.syncedAt).toLocaleString())
                  : t("settings.pairing.remindersNotSynced"),
                device.reminders?.enabled === false ? t("settings.pairing.deviceRemindersOff") : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <span>
                {t(device.connected ? "settings.pairing.online" : "settings.pairing.offline")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("settings.pairing.revokeDevice")
                  .replace("{number}", deviceNumber(device.id))
                  .replace("{name}", () => device.name)}
                disabled={working}
                onClick={() => {
                  setError(false)
                  setRevokeStatus(undefined)
                  setRevoking(device)
                }}
              >
                {t("settings.pairing.revoke")}
              </Button>
            </SettingRow>
          ))
        ) : (
          <SettingRow title={t("settings.pairing.empty")} />
        )}
        {revokeStatus && revokeStatus !== "storage-unavailable" && (
          <SettingRow
            title={<span role="status">{t(`settings.pairing.revokeStatus.${revokeStatus}`)}</span>}
          />
        )}
      </SettingSection>
      <SettingSection title={t("settings.mobilePreview.title")}>
        <SettingRow
          title={t("settings.mobilePreview.enabled")}
          description={t("settings.mobilePreview.description")}
        >
          <Switch
            checked={previewEnabled ?? true}
            disabled={previewEnabled === null || previewSaving}
            aria-label={t("settings.mobilePreview.enabled")}
            onCheckedChange={(checked) => void togglePreviewEnabled(checked)}
          />
        </SettingRow>
        {previewError && (
          <SettingRow title={<span role="alert">{t("settings.mobilePreview.error")}</span>} />
        )}
      </SettingSection>
      <Dialog.Root
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open && !working) dismissRevoke()
        }}
      >
        <Dialog.Content
          title={t("settings.pairing.revoke")}
          description={t("settings.pairing.revokeDescription")
            .replace("{number}", revoking ? deviceNumber(revoking.id) : "")
            .replace("{name}", () => revoking?.name ?? "")}
          closeLabel={t("common.close")}
        >
          {error && <p role="alert">{t("settings.mobileRelay.status.host-unavailable")}</p>}
          {revokeStatus === "storage-unavailable" && (
            <p role="alert">{t("settings.pairing.revokeStatus.storage-unavailable")}</p>
          )}
          <Dialog.Footer>
            <Button
              size="lg"
              type="button"
              variant="ghost"
              disabled={working}
              onClick={dismissRevoke}
            >
              {t("common.cancel")}
            </Button>
            <Button
              size="lg"
              type="button"
              variant="solidDanger"
              disabled={working}
              onClick={revokeDevice}
            >
              {t("settings.pairing.revokeConfirm")}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </>
  )
}
