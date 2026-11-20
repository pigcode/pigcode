import { useEffect, useRef, useState } from "react"
import type {
  AgentAuthAction,
  AgentAuthState,
  AgentCliUpdateState,
  AgentStatus,
} from "@pigcode/contracts"
import { Button, Input, useLocale } from "@pigcode/ui-primitives"
import type { AgentInstanceEntry } from "./agent-instances"

export interface AgentSetupActions {
  auth(instanceId: string, request: AgentAuthAction): Promise<AgentAuthState>
  accountChanged(instanceId: string): void
  cancelInstall(instanceId: string): Promise<void>
  removeInstall(instanceId: string): Promise<void>
}

const authPending = (state?: AgentAuthState) =>
  state?.phase === "starting" || state?.phase === "waiting" || state?.phase === "verifying"

export function AgentSetup({
  entry,
  status,
  actions,
  update,
  onInstall,
  openExternal,
}: {
  entry: AgentInstanceEntry
  status: AgentStatus | undefined
  actions: AgentSetupActions
  update: AgentCliUpdateState | undefined
  onInstall: (() => Promise<void>) | undefined
  openExternal: ((url: string) => void | Promise<void>) | undefined
}) {
  const { t } = useLocale()
  const { agent, instance } = entry
  const instanceId = instance.instanceId
  const enabled = agent.enabled && instance.enabled
  const acp = agent.acpRegistry
  const managed = agent.managedCli && (!acp || Boolean(instance.values.registryId))
  const customBinary = Boolean(instance.values.binaryPath)
  const [auth, setAuth] = useState<AgentAuthState>()
  const [code, setCode] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  const installed = status?.installed === true
  const canInstall = status?.installed === false && onInstall !== undefined
  const authBusy = authPending(auth)
  const cliBusy =
    update?.phase === "queued" || update?.phase === "waiting" || update?.phase === "running"
  const previous = useRef<AgentAuthState>(undefined)
  const authRevision = useRef(0)
  const requestAuth = actions.auth
  const accountChanged = actions.accountChanged

  useEffect(() => {
    let disposed = false
    function refresh() {
      const revision = authRevision.current
      void requestAuth(instanceId, { action: "status" })
        .then((state) => {
          if (!disposed && authRevision.current === revision) setAuth(state)
        })
        .catch(() => undefined)
    }
    refresh()
    const timer = authBusy ? window.setInterval(refresh, 750) : undefined
    return () => {
      disposed = true
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [requestAuth, authBusy, instanceId, status?.authenticated, status?.version])

  useEffect(() => {
    const before = previous.current
    previous.current = auth
    const different =
      auth?.phase === "connected"
        ? status?.authenticated === false
        : auth?.phase === "signed-out" && status?.authenticated === true
    if (
      auth &&
      !authPending(auth) &&
      (authPending(before) || (before?.phase !== auth.phase && different))
    ) {
      accountChanged(instanceId)
    }
  }, [auth, instanceId, accountChanged, status?.authenticated])

  async function perform(action: () => Promise<unknown>) {
    setPending(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }

  function authorize(request: AgentAuthAction) {
    authRevision.current += 1
    void perform(async () => {
      const next = await requestAuth(instanceId, request)
      setAuth(next)
      if (request.action === "submit" || request.action === "cancel") setCode("")
    })
  }

  const flow = auth?.flowId
  const url = auth?.authorizationUrl
  const linked = auth?.phase === "connected"
  const stage = update?.progress
  const installMessage =
    stage?.stage === "downloading"
      ? "agents.setup.downloading"
      : stage?.stage === "extracting"
        ? "agents.setup.extracting"
        : stage?.stage === "verifying"
          ? "agents.setup.checkingCli"
          : "agents.setup.installing"
  return (
    <div className="agent-setup">
      {managed && !customBinary && (cliBusy || canInstall || update?.canRemove) ? (
        <div className="agent-setup-actions">
          {cliBusy ? (
            <>
              <span role="status">{t(acp ? "agents.acp.installing" : installMessage)}</span>
              {stage?.stage === "downloading" && stage.total && stage.bytes !== undefined ? (
                <progress
                  max={stage.total}
                  value={Math.min(stage.total, stage.bytes)}
                  aria-label={t(installMessage)}
                />
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => void perform(() => actions.cancelInstall(instanceId))}
              >
                {t("agents.setup.cancel")}
              </Button>
            </>
          ) : canInstall && onInstall ? (
            <Button
              size="sm"
              disabled={pending || !enabled}
              onClick={() => void perform(onInstall)}
            >
              {t(acp ? "agents.acp.install" : "agents.setup.install")}
            </Button>
          ) : confirmRemoval ? (
            <>
              <Button
                size="sm"
                variant="danger"
                disabled={pending}
                onClick={() =>
                  void perform(async () => {
                    await actions.removeInstall(instanceId)
                    setConfirmRemoval(false)
                  })
                }
              >
                {t("agents.setup.remove")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => setConfirmRemoval(false)}
              >
                {t("agents.setup.cancel")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setConfirmRemoval(true)}
            >
              {t("agents.setup.remove")}
            </Button>
          )}
        </div>
      ) : null}
      {installed && !status?.error ? (
        <div className="agent-setup-actions">
          {authBusy && flow ? (
            <>
              <span role="status">
                {t(
                  auth?.phase === "starting"
                    ? acp
                      ? "agents.acp.signingIn"
                      : "agents.setup.starting"
                    : auth?.phase === "waiting"
                      ? "agents.setup.awaitingCode"
                      : "agents.setup.verifying",
                )}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => authorize({ action: "cancel", flowId: flow })}
              >
                {t("agents.setup.cancel")}
              </Button>
            </>
          ) : linked && !auth?.usingCliLogin && auth?.canLogout !== false ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => authorize({ action: "logout" })}
            >
              {t(acp ? "agents.acp.signOut" : "agents.setup.signOut")}
            </Button>
          ) : acp ? (
            linked ? null : (
              auth?.methods?.map((method) => (
                <Button
                  key={method.id}
                  size="sm"
                  disabled={pending || !enabled}
                  onClick={() => authorize({ action: "start", methodId: method.id })}
                >
                  {t("agents.acp.signIn").replace("{method}", method.name)}
                </Button>
              ))
            )
          ) : (
            <Button
              size="sm"
              disabled={pending || !enabled || !auth}
              onClick={() => authorize({ action: "start" })}
            >
              {t(auth?.usingCliLogin ? "agents.setup.signInSeparate" : "agents.setup.signIn")}
            </Button>
          )}
        </div>
      ) : null}
      {enabled && auth?.phase === "waiting" && flow && url ? (
        <form
          className="agent-setup-actions"
          onSubmit={(event) => {
            event.preventDefault()
            if (code.trim()) authorize({ action: "submit", flowId: flow, response: code })
          }}
        >
          <Button
            size="sm"
            type="button"
            variant="secondary"
            disabled={!openExternal || pending}
            onClick={() => void perform(async () => openExternal?.(url))}
          >
            {t("agents.setup.openGoogle")}
          </Button>
          <Input
            type="password"
            size="sm"
            value={code}
            aria-label={t("agents.setup.code")}
            placeholder={t("agents.setup.code")}
            maxLength={16_384}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setCode(event.target.value)}
          />
          <Button size="sm" type="submit" disabled={!code.trim() || pending}>
            {t("agents.setup.connect")}
          </Button>
        </form>
      ) : null}
      {error || auth?.error || (!cliBusy && update?.error) ? (
        <p className="error-text" role="alert">
          {error ?? auth?.error ?? update?.error}
        </p>
      ) : null}
    </div>
  )
}
