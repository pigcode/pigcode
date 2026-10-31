/** Worktree 选择器：创建、切换与删除线程的 worktree。 */
import { useState } from "react"
import { ChevronDown, GitBranch } from "lucide-react"
import { Button, EmptyState, Select } from "@pigcode/ui-primitives"

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
  /** 紧凑模式：用于工作台文件 tab 顶部的一行工具条。 */
  compact?: boolean
}

/** 「项目根目录」在 Select 里的值；worktree 路径不会以冒号开头。 */
const ROOT = ":root"
const ROOT_LABEL = "项目根目录"

/** Worktree 选择器入口；删除只针对当前活动 worktree，并要求二次确认。 */
export function WorktreePicker({
  worktrees,
  activePath,
  onCreate,
  onSwitch,
  onRemove,
  busy = false,
  compact = false,
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

  if (compact) {
    return (
      <div className="worktree-compact">
        <span className="worktree-compact-label">工作树</span>
        <Select.Root
          value={activePath ?? ROOT}
          disabled={disabled}
          onValueChange={(next) => {
            if (typeof next === "string" && next !== ROOT) void run(() => onSwitch(next))
          }}
        >
          <Select.Trigger
            className="input select-trigger worktree-compact-select"
            aria-label="工作树"
          >
            <Select.Value className="grow truncate">
              {(value: string) =>
                value === ROOT
                  ? ROOT_LABEL
                  : (worktrees.find((worktree) => worktree.path === value)?.branch ?? value)
              }
            </Select.Value>
            <ChevronDown className="ic ic-sm" aria-hidden="true" />
          </Select.Trigger>
          <Select.Portal>
            <Select.Positioner sideOffset={6} alignItemWithTrigger={false}>
              <Select.Popup>
                <Select.Item value={ROOT}>
                  <Select.ItemText>{ROOT_LABEL}</Select.ItemText>
                </Select.Item>
                {worktrees.map((worktree) => (
                  <Select.Item key={worktree.id} value={worktree.path}>
                    <Select.ItemText>{worktree.branch ?? worktree.path}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Popup>
            </Select.Positioner>
          </Select.Portal>
        </Select.Root>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void run(onCreate)}>
          新建
        </Button>
        {activePath ? (
          <Button
            variant={confirmRemove ? "danger" : "ghost"}
            size="sm"
            disabled={disabled}
            onClick={() => {
              if (confirmRemove) void run(onRemove)
              else setConfirmRemove(true)
            }}
          >
            {confirmRemove ? "确认移除" : "移除"}
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="worktree-picker">
      <header className="workbench-section-header">
        <span>工作树</span>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => void run(onCreate)}
        >
          新建工作树
        </Button>
      </header>
      {worktrees.length === 0 ? (
        <EmptyState
          size="compact"
          icon={<GitBranch className="ic" />}
          title="尚未创建工作树，当前使用项目根目录。"
        />
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
