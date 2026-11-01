/** Checkpoint 面板：列出 baseline/final/manual，恢复前要求二次确认。 */
import { useState } from "react"
import { History } from "lucide-react"
import {
  Button,
  EmptyState,
  formatDateTime,
  useLocale,
  type MessageKey,
} from "@pigcode/ui-primitives"

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
}

/** 阶段标签的文案；Diff 基准下拉也用它。 */
export const CHECKPOINT_PHASE_LABELS: Record<CheckpointPhase, MessageKey> = {
  baseline: "checkpoint.phase.baseline",
  final: "checkpoint.phase.final",
  manual: "checkpoint.phase.manual",
}

/** Checkpoint 面板入口。 */
export function CheckpointPanel({
  checkpoints,
  onRestore,
  restoring = false,
}: CheckpointPanelProps) {
  const { t, locale } = useLocale()
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
      <EmptyState
        icon={<History className="ic" />}
        title={t("workbench.checkpoint.empty")}
        description={t("workbench.checkpoint.emptyHint")}
      />
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
                  {t(CHECKPOINT_PHASE_LABELS[checkpoint.phase])}
                </span>
                {/* 基线与结束检查点没有自己的名字，阶段徽标已经说明了它是什么 */}
                {checkpoint.label ? (
                  <span className="checkpoint-label">{checkpoint.label}</span>
                ) : null}
                <span className="checkpoint-time">
                  {formatDateTime(checkpoint.createdAt, locale)}
                </span>
              </div>
              {confirming ? (
                <div className="checkpoint-actions">
                  <span className="checkpoint-confirm">{t("checkpoint.restorePrompt")}</span>
                  <Button
                    variant="solidDanger"
                    size="sm"
                    disabled={busy}
                    onClick={() => void restore(checkpoint.id)}
                  >
                    {pending ? t("checkpoint.restoring") : t("checkpoint.confirmRestore")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setConfirmingId(null)}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirmingId(checkpoint.id)}
                >
                  {t("checkpoint.restore")}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
