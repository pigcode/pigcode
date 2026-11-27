/**
 * 「远程主机」设置页与「添加远程主机」弹窗：
 * 按确认顺序将「共享当前本机」（生成 pigcode://pair?... 链接、核对 6 位验证码与管理授权桌面端）置顶，
 * 其次配置默认目标主机策略，最后管理已添加的远程主机与无头 CLI 接入引导。
 */
import { useEffect, useRef, useState } from "react"
import {
  HOST_LOCAL_ID,
  desktopPairingViewSchema,
  desktopRevokeResultSchema,
  relaySettingsSchema,
  type DesktopAuthorizedClient,
  type DesktopPairingView,
  type DesktopRevokeResult,
  type HostSummary,
} from "@pigcode/contracts"
import { useAppStore, useHostPool } from "@pigcode/client-runtime"
import {
  Button,
  Dialog,
  HostDot,
  HostPickerMenu,
  Input,
  SettingPage,
  SettingRow,
  SettingSection,
  copyText,
  useLocale,
} from "@pigcode/ui-primitives"
import { AddRemoteHostDialog } from "./add-remote-host-dialog"
import type { CoreDeps } from "./chat-container"
import { useSettingsHostScope } from "./settings-host-scope"

export { AddRemoteHostDialog }

export function RemoteHostsSettingsPage({ deps }: { deps: CoreDeps }) {
  const { t } = useLocale()
  const scope = useSettingsHostScope(deps)
  const poolSnap = useHostPool(scope.hostPool)
  const localConnected = useAppStore(deps.store).status === "connected"
  const { connection } = deps

  const [desktopView, setDesktopView] = useState<DesktopPairingView | null>(null)
  const [relayConfigured, setRelayConfigured] = useState<boolean | null>(null)
  const [shareWorking, setShareWorking] = useState(false)
  const [shareError, setShareError] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)
  const [revokingClient, setRevokingClient] = useState<DesktopAuthorizedClient | null>(null)
  const [revokeStatus, setRevokeStatus] = useState<DesktopRevokeResult["status"] | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [removingHost, setRemovingHost] = useState<HostSummary | null>(null)
  const [renamingHost, setRenamingHost] = useState<HostSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState("")

  const mounted = useRef(true)
  const attemptIdRef = useRef<string | null>(null)
  const revisionRef = useRef(0)

  useEffect(() => {
    mounted.current = true
    if (!localConnected) return
    let active = true
    const refresh = async () => {
      const startRev = revisionRef.current
      try {
        const raw = await connection.call("desktop.pairing", {})
        if (!active || !mounted.current || startRev !== revisionRef.current) return
        const parsed = desktopPairingViewSchema.parse(raw)
        attemptIdRef.current = parsed.attempt?.id ?? null
        setDesktopView(parsed)
        setShareError(false)
      } catch {
        if (active && mounted.current) setShareError(true)
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 750)
    void connection.call("relay.settings", {}).then(
      (raw) => {
        if (!active || !mounted.current) return
        const parsed = relaySettingsSchema.safeParse(raw)
        setRelayConfigured(parsed.success ? Boolean(parsed.data.tokenConfigured) : false)
      },
      () => {
        if (active && mounted.current) setRelayConfigured(false)
      },
    )
    return () => {
      active = false
      mounted.current = false
      clearInterval(timer)
      const activeAttempt = attemptIdRef.current
      attemptIdRef.current = null
      if (activeAttempt) {
        void connection.call("desktop.pairing.cancel", { id: activeAttempt }).catch(() => undefined)
      }
    }
  }, [connection, localConnected])

  async function runShare(op: () => Promise<unknown>) {
    if (shareWorking) return
    revisionRef.current += 1
    setShareWorking(true)
    setShareError(false)
    setCopiedLink(false)
    try {
      const parsed = desktopPairingViewSchema.parse(await op())
      if (mounted.current) {
        attemptIdRef.current = parsed.attempt?.id ?? null
        setDesktopView(parsed)
      }
    } catch {
      if (mounted.current) setShareError(true)
    } finally {
      if (mounted.current) setShareWorking(false)
    }
  }

  async function confirmRevokeClient() {
    if (!revokingClient || shareWorking) return
    revisionRef.current += 1
    setShareWorking(true)
    try {
      const result = desktopRevokeResultSchema.parse(
        await connection.call("desktop.devices.revoke", { deviceId: revokingClient.id }),
      )
      if (mounted.current) {
        setRevokeStatus(result.status)
        setDesktopView(result.pairing)
        if (result.status !== "storage-unavailable") setRevokingClient(null)
      }
    } catch {
      if (mounted.current) setShareError(true)
    } finally {
      if (mounted.current) setShareWorking(false)
    }
  }

  const attempt = desktopView?.attempt
  const candidate = attempt?.candidate
  const seconds = attempt ? Math.max(0, Math.ceil((attempt.expiresAt - Date.now()) / 1000)) : 0
  const remaining = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
  const shareStatusText = shareError
    ? t("settings.mobileRelay.status.host-unavailable")
    : desktopView?.status && desktopView.status !== "idle"
      ? t(`settings.remoteHosts.share.status.${desktopView.status}`)
      : undefined

  const remoteHosts = poolSnap.hosts.filter((h) => h.id !== HOST_LOCAL_ID)

  return (
    <SettingPage
      title={t("settings.remoteHosts.pageTitle")}
      sub={t("settings.remoteHosts.subtitle")}
      actions={
        <Button type="button" size="lg" variant="primary" onClick={() => setAddOpen(true)}>
          {t("hosts.addHost")}
        </Button>
      }
    >
      {/* 1. 置顶核心功能：共享当前本机 */}
      <SettingSection title={t("settings.remoteHosts.share.title")}>
        <SettingRow
          title={t("settings.remoteHosts.share.description")}
          description={
            relayConfigured === false ? t("settings.remoteHosts.share.noRelayNote") : undefined
          }
        >
          <Button
            size="sm"
            variant="primary"
            disabled={!localConnected || shareWorking}
            onClick={() => void runShare(() => connection.call("desktop.pairing.start", {}))}
          >
            {t(
              attempt || desktopView?.status === "expired"
                ? "settings.remoteHosts.share.regenerate"
                : "settings.remoteHosts.share.generate",
            )}
          </Button>
        </SettingRow>

        {attempt?.link ? (
          <SettingRow
            title={
              <div className="host-link-box">
                <span className="host-link-code truncate">{attempt.link}</span>
                <Button
                  size="sm"
                  type="button"
                  onClick={() => void copyText(attempt.link!).then(() => setCopiedLink(true))}
                >
                  {copiedLink
                    ? t("settings.remoteHosts.share.copied")
                    : t("settings.remoteHosts.share.copyLink")}
                </Button>
              </div>
            }
          />
        ) : null}

        {attempt ? (
          <SettingRow
            title={t("settings.remoteHosts.share.expires")}
            description={<span className="mono">{remaining}</span>}
          >
            <Button
              size="sm"
              variant="ghost"
              disabled={shareWorking}
              onClick={() =>
                void runShare(() => connection.call("desktop.pairing.cancel", { id: attempt.id }))
              }
            >
              {t("settings.remoteHosts.share.cancel")}
            </Button>
          </SettingRow>
        ) : null}

        {attempt && candidate ? (
          <SettingRow
            title={`${t("settings.remoteHosts.share.candidateTitle")} · ${candidate.name} (${candidate.platform})`}
            description={<span className="host-verify-digits">{candidate.code}</span>}
          >
            <Button
              size="sm"
              variant="primary"
              disabled={shareWorking || seconds === 0}
              onClick={() =>
                void runShare(() =>
                  connection.call("desktop.pairing.confirm", {
                    id: attempt.id,
                    confirmation: candidate.confirmation,
                  }),
                )
              }
            >
              {t("settings.remoteHosts.share.confirmAllow")}
            </Button>
          </SettingRow>
        ) : null}

        {shareStatusText ? (
          <SettingRow title={<span role="status">{shareStatusText}</span>} />
        ) : null}
      </SettingSection>

      <SettingSection title={t("settings.remoteHosts.share.clientsTitle")}>
        {desktopView?.clients.length ? (
          desktopView.clients.map((client) => (
            <SettingRow
              key={client.id}
              title={client.name}
              description={[
                client.platform,
                client.lastConnectedAt !== null
                  ? new Date(client.lastConnectedAt).toLocaleString()
                  : t("settings.pairing.neverConnected"),
              ].join(" · ")}
            >
              <span>
                {t(client.connected ? "settings.pairing.online" : "settings.pairing.offline")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={shareWorking}
                onClick={() => {
                  setRevokeStatus(null)
                  setRevokingClient(client)
                }}
              >
                {t("settings.remoteHosts.share.revoke")}
              </Button>
            </SettingRow>
          ))
        ) : (
          <SettingRow title={t("settings.remoteHosts.share.clientsEmpty")} />
        )}
        {revokeStatus && revokeStatus !== "storage-unavailable" ? (
          <SettingRow
            title={<span role="status">{t(`settings.pairing.revokeStatus.${revokeStatus}`)}</span>}
          />
        ) : null}
      </SettingSection>

      {/* 2. 默认目标主机策略 */}
      <SettingSection title={t("settings.remoteHosts.default.title")}>
        <SettingRow
          title={t("settings.remoteHosts.default.label")}
          description={t("settings.remoteHosts.default.description")}
        >
          <HostPickerMenu
            hosts={poolSnap.hosts}
            value={poolSnap.defaults.defaultTargetHostId}
            onChange={(hostId) => void window.pigcodeNative?.hosts?.setDefault(hostId)}
          />
        </SettingRow>
      </SettingSection>

      {/* 3. 已添加的远程主机清单 */}
      <SettingSection title={t("settings.remoteHosts.list.title")}>
        {remoteHosts.length > 0 ? (
          remoteHosts.map((host) => (
            <SettingRow
              key={host.id}
              title={
                <span className="settings-scope-trigger-main">
                  <HostDot color={host.badgeColor} offline={host.status !== "connected"} />
                  <span>{host.name}</span>
                </span>
              }
              description={[
                host.kind === "headless" ? t("hosts.headlessTag") : t("hosts.remoteTag"),
                t(`settings.remoteHosts.status.${host.status}`),
                t(`settings.remoteHosts.channel.${host.channel}`),
                host.latencyMs !== null ? `${host.latencyMs}ms` : undefined,
                host.lastError ?? undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              {host.status !== "connected" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void window.pigcodeNative?.hosts?.reconnect(host.id)}
                >
                  {t("hosts.reconnect")}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRenamingHost(host)
                  setRenameDraft(host.name)
                }}
              >
                {t("settings.remoteHosts.rename")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRemovingHost(host)}>
                {t("settings.remoteHosts.remove")}
              </Button>
            </SettingRow>
          ))
        ) : (
          <SettingRow title={t("settings.remoteHosts.list.empty")} />
        )}
      </SettingSection>

      <AddRemoteHostDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        pairingState={poolSnap.pairingState}
      />

      <Dialog.Root
        open={revokingClient !== null}
        onOpenChange={(next) => {
          if (!next && !shareWorking) setRevokingClient(null)
        }}
      >
        <Dialog.Content
          title={t("settings.remoteHosts.share.revoke")}
          description={revokingClient?.name}
          closeLabel={t("common.close")}
        >
          <Dialog.Footer>
            <Button type="button" size="lg" variant="ghost" onClick={() => setRevokingClient(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="solidDanger"
              disabled={shareWorking}
              onClick={() => void confirmRevokeClient()}
            >
              {t("settings.pairing.revokeConfirm")}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root
        open={renamingHost !== null}
        onOpenChange={(next) => {
          if (!next) setRenamingHost(null)
        }}
      >
        <Dialog.Content title={t("settings.remoteHosts.rename")} closeLabel={t("common.close")}>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (renamingHost && renameDraft.trim()) {
                void window.pigcodeNative?.hosts
                  ?.rename(renamingHost.id, renameDraft.trim())
                  .then(() => setRenamingHost(null))
              }
            }}
          >
            <Dialog.Body>
              <Input
                size="xl"
                autoFocus
                maxLength={80}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
              />
            </Dialog.Body>
            <Dialog.Footer>
              <Button type="button" size="lg" variant="ghost" onClick={() => setRenamingHost(null)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" size="lg" variant="primary" disabled={!renameDraft.trim()}>
                {t("settings.remoteHosts.renameSave")}
              </Button>
            </Dialog.Footer>
          </form>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root
        open={removingHost !== null}
        onOpenChange={(next) => {
          if (!next) setRemovingHost(null)
        }}
      >
        <Dialog.Content
          title={t("settings.remoteHosts.remove")}
          description={t("settings.remoteHosts.removeConfirm")}
          closeLabel={t("common.close")}
        >
          <Dialog.Footer>
            <Button type="button" size="lg" variant="ghost" onClick={() => setRemovingHost(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="solidDanger"
              onClick={() => {
                if (!removingHost) return
                void window.pigcodeNative?.hosts
                  ?.remove(removingHost.id)
                  .then(() => setRemovingHost(null))
              }}
            >
              {t("settings.remoteHosts.remove")}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </SettingPage>
  )
}
