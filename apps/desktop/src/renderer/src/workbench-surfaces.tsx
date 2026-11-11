/**
 * 六个内置 Surface 的内容：浏览器、终端、文件、Diff、PR 与检查点。数据和操作来自 WorkbenchContext；
 * 这个文件在第一次打开某个内置 Surface 时才加载（见 builtin-surfaces.tsx）。
 */
import { ChevronDown, Loader2, Plus, Trash2 } from "lucide-react"
import type { SurfaceRenderProps } from "@pigcode/client-runtime"
import {
  Button,
  EmptyState,
  Select,
  formatDateTime,
  translate,
  useLocale,
  type Locale,
} from "@pigcode/ui-primitives"
import {
  CHECKPOINT_PHASE_LABELS,
  CheckpointPanel,
  DiffView,
  PrPanel,
  WorktreePicker,
} from "@pigcode/ui-workbench"
import { BrowserSurface } from "./browser-surface"
import { FilesSurface } from "./files-surface"
import { TerminalSurface } from "./terminal-surface"
import { useWorkbench, type CheckpointRecord } from "./workbench-context"

/** Diff 基准下拉里一个 checkpoint 的文字：标签或阶段，加创建时间。 */
function checkpointLabel(checkpoint: CheckpointRecord, locale: Locale): string {
  const name = checkpoint.label ?? translate(locale, CHECKPOINT_PHASE_LABELS[checkpoint.phase])
  return `${name} · ${formatDateTime(checkpoint.createdAt, locale)}`
}

/** 浏览器：切走后保持挂载，页面不重新加载。 */
export function BrowserPane({ tab, active }: SurfaceRenderProps) {
  return (
    <div className="surface-pane" hidden={!active}>
      <BrowserSurface id={tab.id} />
    </div>
  )
}

/** 终端：切走后保持挂载，shell 会话保留；工具栏里可以再开一个或结束这个。 */
export function TerminalPane({ tab, active }: SurfaceRenderProps) {
  const { t } = useLocale()
  const { connection, scope, add, close } = useWorkbench()
  return (
    <div className="surface-pane" hidden={!active}>
      <TerminalSurface
        connection={connection}
        owner={scope}
        active={active}
        tools={
          <>
            <Button
              variant="plain"
              size="icon"
              type="button"
              aria-label={t("terminal.new")}
              title={t("terminal.new")}
              onClick={() => add("terminal")}
            >
              <Plus className="ic ic-sm" aria-hidden="true" />
            </Button>
            <Button
              variant="plain"
              size="icon"
              type="button"
              aria-label={t("terminal.kill")}
              title={t("terminal.kill")}
              onClick={() => close(tab.id)}
            >
              <Trash2 className="ic ic-sm" aria-hidden="true" />
            </Button>
          </>
        }
      />
    </div>
  )
}

/**
 * 文件树：上面是 worktree 选择（worktree 属于会话，新会话草稿里没有）；
 * 打开的文件替换这个标签，文件树收进文件标签的侧栏。
 */
export function FilesPane({ tab }: SurfaceRenderProps) {
  const { worktrees, fileProps, openFile } = useWorkbench()
  return (
    <div className="surface-pane workbench-files">
      {worktrees.available ? (
        <div className="workbench-worktree-compact">
          <WorktreePicker
            worktrees={worktrees.worktrees}
            activePath={worktrees.activePath}
            onCreate={worktrees.create}
            onSwitch={worktrees.switchTo}
            onRemove={worktrees.remove}
            busy={worktrees.busy}
            compact
          />
        </div>
      ) : null}
      <FilesSurface {...fileProps} onOpenFile={(path) => openFile(path, tab.id)} />
    </div>
  )
}

/** Diff：选一个 checkpoint 作基准，和最近的结束快照或当前工作区比较。 */
export function DiffPane() {
  const { t, locale } = useLocale()
  const { diff } = useWorkbench()
  return (
    <div className="surface-pane surface-scroll">
      <div className="workbench-diff">
        {diff.committed.length > 0 ? (
          <div className="workbench-diff-base">
            <Select.Root
              value={diff.baseSha ?? null}
              onValueChange={(next) => diff.setBase(typeof next === "string" && next ? next : null)}
            >
              <Select.Label>{t("workbench.diffBase")}</Select.Label>
              <Select.Trigger className="input select-trigger workbench-diff-base-select">
                <Select.Value className="grow truncate">
                  {(value: string | null) => {
                    const checkpoint = diff.committed.find((item) => item.commitSha === value)
                    return checkpoint ? checkpointLabel(checkpoint, locale) : "HEAD"
                  }}
                </Select.Value>
                <ChevronDown className="ic ic-sm" aria-hidden="true" />
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner sideOffset={6} alignItemWithTrigger={false}>
                  <Select.Popup>
                    {/* 默认基准是最近一次 run 的 baseline，不是固定值；给它一个选项，
                        否则选过一次快照之后就再也回不去了。 */}
                    <Select.Item value="">
                      <Select.ItemText>{t("workbench.diffBaseDefault")}</Select.ItemText>
                    </Select.Item>
                    {[...diff.committed].reverse().map((checkpoint) => (
                      <Select.Item key={checkpoint.id} value={checkpoint.commitSha ?? ""}>
                        <Select.ItemText>{checkpointLabel(checkpoint, locale)}</Select.ItemText>
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </div>
        ) : null}
        {diff.error ? (
          <p className="workbench-error">{diff.error}</p>
        ) : diff.loading ? (
          <EmptyState icon={<Loader2 className="ic spin" />} title={t("workbench.diff.loading")} />
        ) : (
          <DiffView diff={diff.text} />
        )}
      </div>
    </div>
  )
}

/** 检查点：列表、手动创建与恢复。 */
export function CheckpointPane() {
  const { t } = useLocale()
  const { checkpoints } = useWorkbench()
  return (
    <div className="surface-pane surface-scroll">
      <div className="workbench-checkpoints">
        <header className="workbench-section-header">
          <span>{t("workbench.checkpoint")}</span>
          <Button
            variant="secondary"
            size="sm"
            disabled={checkpoints.busy}
            onClick={() => void checkpoints.create()}
          >
            {t("workbench.createCheckpoint")}
          </Button>
        </header>
        {checkpoints.error ? <p className="workbench-error">{checkpoints.error}</p> : null}
        <CheckpointPanel
          checkpoints={checkpoints.list}
          onRestore={checkpoints.restore}
          restoring={checkpoints.busy}
        />
      </div>
    </div>
  )
}

/** PR：当前分支的 PR 状态，或创建 PR 的表单；没有 gh 时显示原因。 */
export function PrPane() {
  const { pr } = useWorkbench()
  return (
    <div className="surface-pane surface-scroll">
      <PrPanel
        pullRequest={pr.pullRequest}
        loading={pr.loading}
        creating={pr.creating}
        error={pr.error}
        onCreate={pr.create}
      />
    </div>
  )
}
