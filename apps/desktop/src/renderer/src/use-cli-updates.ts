import { useCallback, useEffect, useRef, useState } from "react"
import type { AgentCliUpdateState } from "@pigcode/contracts"
import type { Connection } from "@pigcode/client-runtime"

const active = (state: AgentCliUpdateState) =>
  state.phase === "queued" || state.phase === "waiting" || state.phase === "running"

/** 更新在 Host 上运行，离开设置页后仍会继续；回来重新读取进度。 */
export function useCliUpdates(
  connection: Connection,
  connected: boolean,
  onCompleted: () => Promise<void>,
  options: { autoCheck: boolean; instanceIds: readonly string[] } = {
    autoCheck: true,
    instanceIds: [],
  },
) {
  const [states, setStates] = useState<Record<string, AgentCliUpdateState>>({})
  const [checking, setChecking] = useState(false)
  const checks = useRef(0)
  const instanceKey = JSON.stringify(options.instanceIds)
  const previous = useRef(states)
  const completed = useRef(onCompleted)
  completed.current = onCompleted
  const accept = useCallback((next: Record<string, AgentCliUpdateState>) => {
    const finished = Object.values(previous.current).some(
      (state) => active(state) && next[state.instanceId] && !active(next[state.instanceId]!),
    )
    previous.current = next
    setStates(next)
    if (finished) void completed.current().catch(() => undefined)
  }, [])
  const refresh = useCallback(async () => {
    accept((await connection.call("agent.cliUpdates", {})) as Record<string, AgentCliUpdateState>)
  }, [connection, accept])
  const check = useCallback(
    async (instanceId?: string) => {
      checks.current += 1
      setChecking(true)
      try {
        accept(
          (await connection.call(
            "agent.checkCliUpdates",
            instanceId ? { instanceId } : {},
          )) as Record<string, AgentCliUpdateState>,
        )
      } finally {
        checks.current -= 1
        setChecking(checks.current > 0)
      }
    },
    [connection, accept],
  )
  useEffect(() => {
    if (!connected) return
    let cancelled = false
    void (async () => {
      const snapshot = (await connection.call("agent.cliUpdates", {})) as Record<
        string,
        AgentCliUpdateState
      >
      if (cancelled) return
      accept(snapshot)
      if (!options.autoCheck) return
      if (Object.keys(snapshot).length === 0) await check()
      else {
        const missing = (JSON.parse(instanceKey) as string[]).filter((id) => !snapshot[id])
        await Promise.all(missing.map((id) => check(id)))
      }
    })().catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connected, connection, accept, check, options.autoCheck, instanceKey])
  useEffect(() => {
    if (!connected || !options.autoCheck) return
    const timer = window.setInterval(() => void check().catch(() => undefined), 6 * 60 * 60_000)
    return () => window.clearInterval(timer)
  }, [connected, options.autoCheck, check])
  const running = Object.values(states).some(active)
  useEffect(() => {
    if (!connected || !running) return
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 1_000)
    return () => window.clearInterval(timer)
  }, [connected, running, refresh])

  return {
    states,
    checking,
    check,
    async update(instanceId: string) {
      const state = (await connection.call("agent.updateCli", {
        instanceId,
      })) as AgentCliUpdateState
      accept({ ...previous.current, [instanceId]: state })
      await refresh()
    },
  }
}
