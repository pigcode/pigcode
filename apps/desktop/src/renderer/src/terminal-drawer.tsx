/** 底部终端：聊天区下方可拖动高度的抽屉；收起时只隐藏，shell 会话保留。 */
import { useState, type PointerEvent as ReactPointerEvent } from "react"
import { SquareTerminal, X } from "lucide-react"
import type { Connection } from "@pigcode/client-runtime"
import { Button, useLocale } from "@pigcode/ui-primitives"
import { TerminalSurface } from "./terminal-surface"

const MIN_HEIGHT = 140
const DEFAULT_HEIGHT = 260

/** 底部终端属性。 */
export interface TerminalDrawerProps {
  connection: Connection
  threadId: string
  open: boolean
  onClose: () => void
}

/** 抽屉高度不超过聊天区的七成，给消息留出空间。 */
function clampHeight(height: number, container: HTMLElement | null): number {
  const max = Math.max(MIN_HEIGHT, Math.round((container?.clientHeight ?? 800) * 0.7))
  return Math.min(max, Math.max(MIN_HEIGHT, Math.round(height)))
}

export function TerminalDrawer({ connection, threadId, open, onClose }: TerminalDrawerProps) {
  const { t } = useLocale()
  const [height, setHeight] = useState(DEFAULT_HEIGHT)

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault()
    const container = event.currentTarget.closest<HTMLElement>(".panel")
    const startY = event.clientY
    const startHeight = height
    const move = (moveEvent: PointerEvent): void => {
      setHeight(clampHeight(startHeight + startY - moveEvent.clientY, container))
    }
    const up = (): void => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      document.body.classList.remove("is-resizing-rows")
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    document.body.classList.add("is-resizing-rows")
  }

  return (
    <section
      className="terminal-drawer"
      hidden={!open}
      aria-label={t("panel.terminalDrawer")}
      style={{ height }}
    >
      <div className="terminal-drawer-resizer" aria-hidden="true" onPointerDown={startResize} />
      <header className="terminal-drawer-head">
        <SquareTerminal className="ic ic-sm" aria-hidden="true" />
        <span className="grow">{t("workbench.terminal")}</span>
        <Button
          variant="plain"
          size="icon"
          type="button"
          aria-label={t("panel.closeTerminalDrawer")}
          title={t("panel.closeTerminalDrawer")}
          onClick={onClose}
        >
          <X className="ic ic-sm" aria-hidden="true" />
        </Button>
      </header>
      <TerminalSurface connection={connection} threadId={threadId} active={open} />
    </section>
  )
}
