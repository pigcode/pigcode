/**
 * 「守护进程、中继与识别色」设置页（受「当前配置主机 ▾」作用域控制）：
 * 按所选主机（本机或在线远程主机）管理主机名称、识别色、Relay 中继连通性与本机防休眠。
 */
import { useEffect, useId, useState, type FormEvent } from "react"
import {
  HOST_LOCAL_ID,
  hostIdentitySchema,
  relaySettingsSchema,
  relayTestResultSchema,
  type HostBadgeColor,
  type RelaySettingsView,
  type RelayTestResult,
} from "@pigcode/contracts"
import { useAppStore, useHostPool } from "@pigcode/client-runtime"
import {
  Button,
  HOST_COLOR_OPTIONS,
  HostDot,
  Input,
  SettingPage,
  SettingRow,
  SettingSection,
  useLocale,
} from "@pigcode/ui-primitives"
import { KeepAwakeRow } from "@pigcode/ui-settings"
import type { CoreDeps } from "./chat-container"
import { useSettingsHostScope } from "./settings-host-scope"

type RelayStatus = RelayTestResult["status"] | "host-unavailable"

const HEADLESS_QUICK_COMMANDS = [
  "pigcode start",
  "pigcode status",
  "pigcode name <name>",
  "pigcode relay set <wss-url> <token>",
  "pigcode pair --desktop",
].join("\n")

export function DaemonSettingsPage({ deps }: { deps: CoreDeps }) {
  const { t } = useLocale()
  const scope = useSettingsHostScope(deps)
  useHostPool(scope.hostPool)
  const { targetHost, targetDeps } = scope
  const targetConnected = useAppStore(targetDeps.store).status === "connected"
  const isLocal = targetHost.id === HOST_LOCAL_ID
  const connection = targetDeps.connection

  const nameId = useId()
  const addressId = useId()
  const tokenId = useId()

  const [nameInput, setNameInput] = useState(targetHost.name)
  const [nameSaving, setNameSaving] = useState(false)
  const [nameSaved, setNameSaved] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [hostKey, setHostKey] = useState<string | null>(targetHost.hostKey)
  const [runtimeKind, setRuntimeKind] = useState<string>(targetHost.kind)

  const [savedRelay, setSavedRelay] = useState<RelaySettingsView | null>(null)
  const [draftAddress, setDraftAddress] = useState<string | null>(null)
  const [token, setToken] = useState("")
  const [checkingRelay, setCheckingRelay] = useState(false)
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null)

  useEffect(() => {
    setNameInput(targetHost.name)
    setHostKey(targetHost.hostKey)
    setRuntimeKind(targetHost.kind)
    setNameSaved(false)
    setNameError(null)
    setSavedRelay(null)
    setDraftAddress(null)
    setToken("")
    setRelayStatus(null)
  }, [targetHost.id])

  useEffect(() => {
    if (!targetConnected) return
    let active = true
    void connection
      .call("host.identity", {})
      .then((raw) => {
        if (!active) return
        const id = hostIdentitySchema.parse(raw)
        setHostKey(id.hostKey)
        setNameInput(id.hostName)
        setRuntimeKind(id.runtime)
        if (isLocal) {
          scope.hostPool.setLocalIdentity({ hostKey: id.hostKey, hostName: id.hostName })
        }
      })
      .catch(() => undefined)
    void connection.call("relay.settings", {}).then(
      (raw) => {
        const settings = relaySettingsSchema.safeParse(raw)
        if (active && settings.success) setSavedRelay(settings.data)
      },
      () => {
        if (active) setRelayStatus("host-unavailable")
      },
    )
    return () => {
      active = false
    }
  }, [connection, targetConnected, isLocal, scope.hostPool])

  async function saveHostName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = nameInput.trim()
    if (!trimmed || !targetConnected || nameSaving) return
    setNameSaving(true)
    setNameSaved(false)
    setNameError(null)
    try {
      const updated = hostIdentitySchema.parse(
        await connection.call("host.setName", { name: trimmed }),
      )
      setNameInput(updated.hostName)
      if (isLocal) {
        scope.hostPool.setLocalIdentity({ hostKey: updated.hostKey, hostName: updated.hostName })
      } else {
        await window.pigcodeNative?.hosts?.rename(targetHost.id, updated.hostName)
      }
      setNameSaved(true)
    } catch (cause) {
      setNameError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setNameSaving(false)
    }
  }

  function pickBadgeColor(color: HostBadgeColor) {
    if (isLocal) {
      scope.hostPool.setLocalBadgeColor(color)
      return
    }
    void window.pigcodeNative?.hosts?.setBadgeColor(targetHost.id, color)
  }

  const address = draftAddress ?? savedRelay?.address ?? ""
  const canReuseToken = savedRelay?.tokenConfigured && savedRelay.address === address
  const relayDisabled = checkingRelay || !targetConnected

  async function testAndSaveRelay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (relayDisabled) return
    setCheckingRelay(true)
    setRelayStatus(null)
    try {
      const value = await connection.call("relay.testAndSave", { address, token })
      const result = relayTestResultSchema.parse(value)
      setRelayStatus(result.status)
      if (result.status === "saved") {
        setSavedRelay(result.settings)
        setDraftAddress(null)
        setToken("")
      }
    } catch {
      setRelayStatus("host-unavailable")
    } finally {
      setCheckingRelay(false)
    }
  }

  return (
    <SettingPage title={t("settings.daemon.pageTitle")} sub={t("settings.daemon.subtitle")}>
      {!targetConnected ? (
        <div className="host-notice-banner" role="status">
          {t("settings.hostScope.offlineNotice")}
        </div>
      ) : null}

      <form onSubmit={(event) => void saveHostName(event)}>
        <SettingSection title={t("settings.daemon.identityTitle")}>
          <SettingRow
            title={<label htmlFor={nameId}>{t("settings.daemon.hostName")}</label>}
            description={
              nameError ? (
                <span className="error-text" role="alert">
                  {nameError}
                </span>
              ) : nameSaved ? (
                <span role="status">{t("settings.daemon.savedName")}</span>
              ) : undefined
            }
          >
            <Input
              id={nameId}
              value={nameInput}
              maxLength={80}
              disabled={!targetConnected || nameSaving}
              placeholder={t("settings.daemon.hostNamePlaceholder")}
              onChange={(event) => {
                setNameInput(event.target.value)
                setNameSaved(false)
              }}
            />
            <Button
              type="submit"
              size="sm"
              disabled={!targetConnected || nameSaving || !nameInput.trim()}
            >
              {t("settings.daemon.saveName")}
            </Button>
          </SettingRow>

          <SettingRow title={t("settings.daemon.badgeColor")}>
            <div
              className="host-color-swatches"
              role="radiogroup"
              aria-label={t("settings.daemon.badgeColor")}
            >
              {HOST_COLOR_OPTIONS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  className="host-color-swatch"
                  aria-checked={targetHost.badgeColor === color}
                  aria-label={t(`settings.daemon.color.${color}`)}
                  title={t(`settings.daemon.color.${color}`)}
                  onClick={() => pickBadgeColor(color)}
                >
                  <HostDot color={color} />
                </button>
              ))}
            </div>
          </SettingRow>
        </SettingSection>
      </form>

      <form onSubmit={(event) => void testAndSaveRelay(event)}>
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
              disabled={relayDisabled}
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
              disabled={relayDisabled}
              onChange={(event) => setToken(event.target.value)}
            />
          </SettingRow>
          <SettingRow
            title={t("settings.mobileRelay.check")}
            description={
              <span role="status">
                {checkingRelay
                  ? t("settings.mobileRelay.checking")
                  : relayStatus
                    ? t(`settings.mobileRelay.status.${relayStatus}`)
                    : undefined}
              </span>
            }
          >
            <Button type="submit" disabled={relayDisabled}>
              {t("settings.mobileRelay.testAndSave")}
            </Button>
          </SettingRow>
        </SettingSection>
      </form>

      {isLocal ? (
        <KeepAwakeRow />
      ) : (
        <SettingSection>
          <SettingRow title={t("settings.daemon.keepAwakeLocalOnly")} />
        </SettingSection>
      )}

      <SettingSection title={t("settings.daemon.runtimeTitle")}>
        <SettingRow
          title={t("settings.daemon.runtimeKind")}
          value={t(`settings.remoteHosts.channel.${targetHost.channel}`)}
        >
          <span className="muted">
            {runtimeKind === "headless" ? t("hosts.headlessTag") : t("hosts.localTag")}
            {targetHost.latencyMs !== null ? ` · ${targetHost.latencyMs}ms` : ""}
          </span>
        </SettingRow>
        {hostKey ? (
          <SettingRow
            title={t("settings.daemon.hostKey")}
            value={<span className="mono">{hostKey.slice(0, 16)}…</span>}
          />
        ) : null}
        <SettingRow title={t("settings.daemon.cliTip")}>
          <pre className="host-cli-code">{HEADLESS_QUICK_COMMANDS}</pre>
        </SettingRow>
      </SettingSection>
    </SettingPage>
  )
}
