/** Checkpoint 面板：列出 baseline/final/manual，恢复前要求二次确认。 */
import { useState } from "react"
import { History } from "lucide-react"
import { Button, EmptyState } from "@pigcode/ui-primitives"

/** checkpoint 的创建阶段；与 Host 的 CheckpointPhase 保持一致。 */
export type CheckpointPhase = "baseline" | "final" | "manual"

/** 一条 checkpoint 记录；只保留渲染需要的字段。 */
export interface CheckpointItem {
  id: string
  runId: string | null
  phase: CheckpointPhase
  label: string | null
  createdAt: string
}

/** Checkpoint 面板属性；恢复动作由父组件通过 RPC 完成。 */
export interface CheckpointPanelProps {
  checkpoints: readonly CheckpointItem[]
  onRestore: (checkpointId: string) => void | Promise<void>
  restoring?: boolean
  /** 没有 checkpoint 时的标题与说明；容器按 locale 注入。 */
  emptyText?: string | undefined
  emptyHint?: string | undefined
}

/** 阶段中文标签。 */
const PHASE_LABELS: Record<CheckpointPhase, string> = {
  baseline: "基线",
  final: "结束",
  manual: "手动",
}

/** 时间展示；非法时间直接回退到原始字符串。 */
function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/** Checkpoint 面板入口。 */
export function CheckpointPanel({
  checkpoints,
  onRestore,
  restoring = false,
  emptyText = "暂无 checkpoint",
  emptyHint,
}: CheckpointPanelProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const busy = restoring || pendingId !== null

  async function restore(checkpointId: string): Promise<void> {
    setPendingId(checkpointId)
    try {
      await onRestore(checkpointId)
    } catch {
      // 错误提示由调用方负责；这里只保证按钮状态复位。
    } finally {
      setPendingId(null)
      setConfirmingId(null)
    }
  }

  if (checkpoints.length === 0) {
    return (
      <EmptyState icon={<History className="ic" />} title={emptyText} description={emptyHint} />
    )
  }

  return (
    <div className="checkpoint-panel">
      <ul className="checkpoint-list">
        {checkpoints.map((checkpoint) => {
          const confirming = checkpoint.id === confirmingId
          const pending = checkpoint.id === pendingId
          return (
            <li className="checkpoint-item" key={checkpoint.id}>
              <div className="checkpoint-meta">
                <span className={`checkpoint-phase checkpoint-phase-${checkpoint.phase}`}>
                  {PHASE_LABELS[checkpoint.phase]}
                </span>
                <span className="checkpoint-label">{checkpoint.label ?? checkpoint.phase}</span>
                <span className="checkpoint-time">{formatTime(checkpoint.createdAt)}</span>
              </div>
              {confirming ? (
                <div className="checkpoint-actions">
                  <span className="checkpoint-confirm">确认恢复到此 checkpoint？</span>
                  <Button
                    variant="solidDanger"
                    size="sm"
                    disabled={busy}
                    onClick={() => void restore(checkpoint.id)}
                  >
                    {pending ? "恢复中…" : "确认恢复"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmingId(null)}
                  >
                    取消
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmingId(checkpoint.id)}
                >
                  恢复
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
