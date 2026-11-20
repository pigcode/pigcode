import { useEffect, useRef } from "react"
import type { AgentAuthState } from "@pigcode/contracts"
import { TerminalView, type TerminalHandle } from "@pigcode/ui-workbench"

export default function AcpAuthTerminal({
  snapshot,
  onInput,
  onResize,
}: {
  snapshot: NonNullable<AgentAuthState["terminal"]>
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
}) {
  const terminal = useRef<TerminalHandle | null>(null)
  const consumed = useRef(0)
  const latest = useRef(snapshot)
  latest.current = snapshot
  function paint() {
    const screen = terminal.current
    const { output, offset } = latest.current
    if (!screen || consumed.current >= offset) return
    const start = offset - output.length
    if (consumed.current < start) screen.write("\x1bc")
    screen.write(output.slice(Math.max(0, consumed.current - start)))
    consumed.current = offset
  }
  useEffect(paint, [snapshot])
  return (
    <div className="acp-login-terminal">
      <TerminalView
        onData={onInput}
        onResize={onResize}
        onReady={(handle) => {
          terminal.current = handle
          consumed.current = 0
          paint()
          handle?.focus()
        }}
      />
    </div>
  )
}
