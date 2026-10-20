/** Worktree 选择器：创建、切换与删除线程的 worktree。 */
import { useState } from "react"
import { Button } from "@pigcode/ui-primitives"

/** 一条 worktree 记录；branch 为空表示未记录分支。 */
export interface WorktreeItem {
  id: string
  path: string
  branch: string | null
}

/** Worktree 选择器属性；所有动作由父组件通过 RPC 完成。 */
export interface WorktreePickerProps {
  worktrees: readonly WorktreeItem[]
  activePath: string | null
  onCreate: () => void | Promise<void>
  onSwitch: (path: string) => void | Promise<void>
  onRemove: () => void | Promise<void>
  busy?: boolean
}

/** Worktree 选择器入口；删除只针对当前活动 worktree，并要求二次确认。 */
export function WorktreePicker({
  worktrees,
  activePath,
  onCreate,
  onSwitch,
  onRemove,
  busy = false,
}: WorktreePickerProps) {
  const [pending, setPending] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const disabled = busy || pending

  async function run(action: () => void | Promise<void>): Promise<void> {
    setPending(true)
    try {
      await action()
    } catch {
      // 错误提示由调用方负责；这里只保证按钮状态复位。
    } finally {
      setPending(false)
      setConfirmRemove(false)
    }
  }

  return (
    <div className="worktree-picker">
      <header className="workbench-section-header">
        <span>Worktrees</span>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => void run(onCreate)}
        >
          新建 worktree
        </Button>
      </header>
      {worktrees.length === 0 ? (
        <p className="workbench-empty">尚未创建 worktree，当前使用项目根目录。</p>
      ) : (
        <ul className="worktree-list">
          {worktrees.map((worktree) => {
            const active = worktree.path === activePath
            return (
              <li className="worktree-item" key={worktree.id}>
                <div className="worktree-meta">
                  <span className="worktree-path" title={worktree.path}>
                    {worktree.path}
                  </span>
                  <span className="worktree-branch">{worktree.branch ?? "未记录分支"}</span>
                  {active ? <span className="worktree-active">使用中</span> : null}
                </div>
                <div className="worktree-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={disabled || active}
                    onClick={() => void run(() => onSwitch(worktree.path))}
                  >
                    切换
                  </Button>
                  {active ? (
                    confirmRemove ? (
                      <>
                        <span className="worktree-confirm">确认删除？</span>
                        <Button
                          variant="solidDanger"
                          size="sm"
                          disabled={disabled}
                          onClick={() => void run(onRemove)}
                        >
                          确认删除
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={disabled}
                          onClick={() => setConfirmRemove(false)}
                        >
                          取消
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={disabled}
                        onClick={() => setConfirmRemove(true)}
                      >
                        删除
                      </Button>
                    )
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
