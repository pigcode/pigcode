/** 「添加远程主机」弹窗：支持粘贴桌面端配对链接（`pigcode://pair?...`）与无头服务端命令行接入指引。 */
import { useEffect, useId, useRef, useState, type FormEvent } from "react"
import type { HostBadgeColor, HostOutboundPairingStatus } from "@pigcode/contracts"
import {
  Button,
  Dialog,
  HOST_COLOR_OPTIONS,
  HostDot,
  Input,
  Tabs,
  copyText,
  useLocale,
} from "@pigcode/ui-primitives"

const HEADLESS_INSTALL_GUIDE = [
  "npm install -g @pigcode/host",
  "pigcode start",
  "pigcode relay set wss://your-relay.example/ws/v1/connect <token>",
  "pigcode pair --desktop",
].join("\n")

const PAIRING_ERROR_KEYS = {
  invalid: "settings.remoteHosts.add.error.invalid",
  "mobile-only": "settings.remoteHosts.add.error.mobile-only",
  "self-pairing": "settings.remoteHosts.add.error.self-pairing",
  expired: "settings.remoteHosts.add.error.expired",
  unreachable: "settings.remoteHosts.add.error.unreachable",
  "token-rejected": "settings.remoteHosts.add.error.token-rejected",
  "pairing-rejected": "settings.remoteHosts.add.error.pairing-rejected",
  busy: "settings.remoteHosts.add.error.busy",
} as const

function mapAddErrorKey(code: string | null) {
  if (code && code in PAIRING_ERROR_KEYS) {
    return PAIRING_ERROR_KEYS[code as keyof typeof PAIRING_ERROR_KEYS]
  }
  return "settings.remoteHosts.add.error.unreachable"
}

export function AddRemoteHostDialog({
  open,
  onOpenChange,
  pairingState,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pairingState: HostOutboundPairingStatus
}) {
  const { t } = useLocale()
  const linkId = useId()
  const nameId = useId()
  const [tab, setTab] = useState<string>("paste")
  const [link, setLink] = useState("")
  const [customName, setCustomName] = useState("")
  const [badgeColor, setBadgeColor] = useState<HostBadgeColor>("green")
  const [submitting, setSubmitting] = useState(false)
  const [cliCopied, setCliCopied] = useState(false)
  const prevStateRef = useRef<HostOutboundPairingStatus["state"]>(pairingState.state)

  useEffect(() => {
    if (open && prevStateRef.current !== "paired" && pairingState.state === "paired") {
      setLink("")
      setCustomName("")
      onOpenChange(false)
    }
    prevStateRef.current = pairingState.state
  }, [open, pairingState.state, onOpenChange])

  function close(next: boolean) {
    if (!next && (pairingState.state === "connecting" || pairingState.state === "verify")) {
      void window.pigcodeNative?.hosts?.cancelPairing()
    }
    if (!next) {
      setSubmitting(false)
      setCliCopied(false)
    }
    onOpenChange(next)
  }

  async function submitPairing(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!link.trim() || submitting) return
    setSubmitting(true)
    try {
      await window.pigcodeNative?.hosts?.startPairing({
        link: link.trim(),
        ...(customName.trim() ? { customName: customName.trim() } : {}),
        badgeColor,
      })
    } finally {
      setSubmitting(false)
    }
  }

  const busy = pairingState.state === "connecting" || pairingState.state === "verify"

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Content
        className="project-dialog"
        title={t("settings.remoteHosts.add.title")}
        closeLabel={t("common.close")}
      >
        <Tabs.Root value={tab} onValueChange={setTab}>
          <Dialog.Body>
            <Tabs.List>
              <Tabs.Tab value="paste">{t("settings.remoteHosts.add.tabPaste")}</Tabs.Tab>
              <Tabs.Tab value="cli">{t("settings.remoteHosts.add.tabCli")}</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="paste">
              <form id="add-remote-host-form" onSubmit={(event) => void submitPairing(event)}>
                <div className="field">
                  <label htmlFor={linkId} className="label">
                    {t("settings.remoteHosts.add.linkLabel")}
                  </label>
                  <Input
                    id={linkId}
                    size="xl"
                    className="mono"
                    value={link}
                    disabled={busy}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t("settings.remoteHosts.add.linkPlaceholder")}
                    onChange={(event) => setLink(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={nameId} className="label">
                    {t("settings.remoteHosts.add.nameLabel")}
                  </label>
                  <Input
                    id={nameId}
                    size="xl"
                    value={customName}
                    disabled={busy}
                    maxLength={80}
                    placeholder={t("settings.remoteHosts.add.namePlaceholder")}
                    onChange={(event) => setCustomName(event.target.value)}
                  />
                </div>
                <div className="field">
                  <span className="label">{t("settings.remoteHosts.add.colorLabel")}</span>
                  <div
                    className="host-color-swatches"
                    role="radiogroup"
                    aria-label={t("settings.remoteHosts.add.colorLabel")}
                  >
                    {HOST_COLOR_OPTIONS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        role="radio"
                        className="host-color-swatch"
                        aria-checked={badgeColor === color}
                        aria-label={t(`settings.daemon.color.${color}`)}
                        onClick={() => setBadgeColor(color)}
                      >
                        <HostDot color={color} />
                      </button>
                    ))}
                  </div>
                </div>
                {pairingState.state === "verify" && pairingState.verificationCode ? (
                  <div className="host-notice-banner" role="status">
                    <div>
                      <strong>{t("settings.remoteHosts.add.verifyTitle")}</strong>
                      <p className="muted">{t("settings.remoteHosts.add.verifyHint")}</p>
                    </div>
                    <span className="host-verify-digits">{pairingState.verificationCode}</span>
                  </div>
                ) : null}
                {pairingState.state === "failed" ? (
                  <p className="error-text" role="alert">
                    {t(mapAddErrorKey(pairingState.errorCode))}
                  </p>
                ) : null}
              </form>
            </Tabs.Panel>

            <Tabs.Panel value="cli">
              <div className="field">
                <p className="muted">{t("settings.remoteHosts.add.cliDesc")}</p>
                <pre className="host-cli-code">{HEADLESS_INSTALL_GUIDE}</pre>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void copyText(HEADLESS_INSTALL_GUIDE).then(() => setCliCopied(true))}
              >
                {cliCopied ? t("settings.remoteHosts.share.copied") : t("openIn.copyPath")}
              </Button>
            </Tabs.Panel>
          </Dialog.Body>
          <Dialog.Footer>
            <Button type="button" size="lg" variant="ghost" onClick={() => close(false)}>
              {t("common.cancel")}
            </Button>
            {tab === "paste" ? (
              <Button
                type="submit"
                form="add-remote-host-form"
                size="lg"
                variant="primary"
                disabled={!link.trim() || busy || submitting}
              >
                {busy
                  ? t("settings.remoteHosts.add.connecting")
                  : t("settings.remoteHosts.add.connect")}
              </Button>
            ) : null}
          </Dialog.Footer>
        </Tabs.Root>
      </Dialog.Content>
    </Dialog.Root>
  )
}
