import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react"
import type { AgentAuthAction, AgentAuthState } from "@pigcode/contracts"
import { Button, useLocale } from "@pigcode/ui-primitives"
import type { AgentSetupActions } from "./agent-setup"

const AuthTerminal = lazy(() => import("./acp-auth-terminal"))
export const acpAuthPending = (phase?: AgentAuthState["phase"]) =>
  phase === "starting" || phase === "waiting" || phase === "verifying"

/** 设置卡片和创建后的登录步骤共用同一个实例认证流程。 */
export function AcpAccount({
  instanceId,
  actions,
  enabled = true,
  onPhase,
  methodId,
}: {
  instanceId: string
  actions: AgentSetupActions
  enabled?: boolean
  methodId?: string | undefined
  onPhase?: ((phase: AgentAuthState["phase"] | undefined) => void) | undefined
}) {
  const { t } = useLocale()
  const { auth: request, accountChanged } = actions
  const [state, setState] = useState<AgentAuthState>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState<AgentAuthAction["action"] | null>(null)
  const loading = pending !== null
  const revision = useRef(0)
  const active = acpAuthPending(state?.phase)
  const terminal = Boolean(state?.terminal)
  const send = useCallback(
    async (action: AgentAuthAction) => {
      const current = ++revision.current
      setPending(action.action)
      setError(undefined)
      try {
        const result = await request(instanceId, action)
        if (current === revision.current) {
          setState(result)
          if (
            action.action === "logout" ||
            (action.action === "start" && !acpAuthPending(result.phase))
          )
            accountChanged(instanceId)
        }
      } catch (cause) {
        if (current === revision.current)
          setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (current === revision.current) setPending(null)
      }
    },
    [instanceId, request, accountChanged],
  )

  useEffect(() => {
    void send({ action: "status", refresh: enabled })
    return () => {
      revision.current++
    }
  }, [send, enabled])
  useEffect(() => {
    onPhase?.(pending === "start" || pending === "cancel" ? "starting" : state?.phase)
  }, [onPhase, pending, state?.phase])
  useEffect(() => {
    if (!active) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const current = revision.current
      let finished = false
      try {
        const result = await request(instanceId, { action: "status" })
        if (disposed || current !== revision.current) return
        setState(result)
        setError(undefined)
        if (!acpAuthPending(result.phase)) {
          finished = true
          accountChanged(instanceId)
          return
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!disposed && !finished) timer = setTimeout(poll, terminal ? 160 : 500)
      }
    }
    timer = setTimeout(poll, terminal ? 80 : 300)
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [active, terminal, instanceId, request, accountChanged])

  const flowId = state?.flowId
  function interact(input: { data?: string; size?: { cols: number; rows: number } }) {
    if (flowId)
      void request(instanceId, { action: "terminal", flowId, ...input }).catch(() => undefined)
  }
  const methods = state?.methods ?? []
  const choices =
    methodId && methods.some((method) => method.id === methodId)
      ? methods.filter((method) => method.id === methodId)
      : methods
  return (
    <div className="acp-account">
      <div className="agent-setup-actions">
        {active ? (
          <>
            <span role="status">
              {t(
                state?.phase === "verifying"
                  ? "agents.acp.verifying"
                  : terminal
                    ? "agents.acp.terminalPrompt"
                    : "agents.acp.signingIn",
              )}
            </span>
            {flowId && (
              <Button
                size="sm"
                type="button"
                variant="ghost"
                disabled={loading}
                onClick={() => void send({ action: "cancel", flowId })}
              >
                {t("agents.setup.cancel")}
              </Button>
            )}
          </>
        ) : state?.phase === "connected" ? (
          <>
            <span role="status">{t("agents.acp.connected")}</span>
            {!onPhase && state.canLogout && (
              <Button
                size="sm"
                variant="ghost"
                disabled={loading}
                onClick={() => void send({ action: "logout" })}
              >
                {t("agents.acp.signOut")}
              </Button>
            )}
          </>
        ) : !state && loading ? (
          <span role="status">{t("agents.acp.discovering")}</span>
        ) : choices.length > 0 ? (
          choices.map((method) => (
            <Button
              key={method.id}
              size="sm"
              type="button"
              disabled={!enabled || loading}
              onClick={() => void send({ action: "start", methodId: method.id })}
            >
              {t("agents.acp.signIn").replace("{method}", method.name)}
            </Button>
          ))
        ) : (
          <span className="agent-muted">{t("agents.acp.externalSignIn")}</span>
        )}
      </div>
      {state?.terminal && flowId ? (
        <Suspense fallback={<span role="status">{t("agents.acp.terminalPrompt")}</span>}>
          <AuthTerminal
            key={flowId}
            snapshot={state.terminal}
            onInput={(data) => interact({ data })}
            onResize={(cols, rows) => interact({ size: { cols, rows } })}
          />
        </Suspense>
      ) : null}
      {(error || state?.error) && (
        <p className="error-text" role="alert">
          {error ?? state?.error}
        </p>
      )}
      {!active && !loading && state?.phase !== "connected" && (
        <Button
          size="sm"
          type="button"
          variant="ghost"
          onClick={() => void send({ action: "status", refresh: true })}
        >
          {t("agents.acp.recheck")}
        </Button>
      )}
    </div>
  )
}
