import type { AgentCliUpdateState, DesktopUpdateState } from "@pigcode/contracts"

export function cliUpdateRunning(state: AgentCliUpdateState): boolean {
  return state.phase === "queued" || state.phase === "waiting" || state.phase === "running"
}

/** 多个实例使用同一安装时只显示一行，打开浮层期间保留已完成的结果。 */
export function cliUpdateItems(
  states: Readonly<Record<string, AgentCliUpdateState>>,
  includeCompleted = false,
): AgentCliUpdateState[] {
  const items = new Map<string, AgentCliUpdateState>()
  for (const state of Object.values(states)) {
    const relevant =
      state.available ||
      cliUpdateRunning(state) ||
      state.phase === "unchanged" ||
      (state.phase === "failed" && state.command !== null) ||
      (includeCompleted && state.phase === "succeeded")
    if (relevant && !items.has(state.target)) items.set(state.target, state)
  }
  return [...items.values()]
}

export function hasAppUpdate(state: DesktopUpdateState | null): boolean {
  return Boolean(state?.version && state.action)
}
