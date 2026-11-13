/**
 * Workbench 交给内置 Surface 的数据与操作。WorkbenchPanel 提供，内置 Surface 的 render 读取；
 * 这个文件只有类型和 context，登记内置 Surface 时不会把工作台的代码带进首屏。
 */
import { createContext, useContext, type ComponentProps } from "react"
import type { Connection } from "@pigcode/client-runtime"
import type { CheckpointPhase } from "@pigcode/ui-workbench"
import type { FilesSurface } from "./files-surface"
import type { usePullRequest } from "./use-pull-request"
import type { useWorktrees } from "./use-worktrees"
import type { WorkspaceScope } from "./workspace-scope"

/** checkpoint.list 返回的记录；只保留 UI 需要的字段。 */
export interface CheckpointRecord {
  id: string
  runId: string | null
  phase: CheckpointPhase
  commitSha: string | null
  label: string | null
  createdAt: string
}

/** 内置 Surface 需要的一切。 */
export interface WorkbenchContextValue {
  connection: Connection
  /** 会话，或者新会话草稿的项目。 */
  scope: WorkspaceScope
  /** 打开一个 Surface（扩展点上的 id）。 */
  add(kind: string): void
  /** 关闭一个标签；有未保存修改的文件标签先确认。 */
  close(id: string): void
  /** 从当前文件导航打开文件，可以复用预览标签或保留独立标签。 */
  openFile(path: string, sourceId: string, preview: boolean): void
  /** 文件树与文件标签共用的属性。 */
  fileProps: Omit<ComponentProps<typeof FilesSurface>, "onOpenFile" | "onOpenFileTab">
  worktrees: ReturnType<typeof useWorktrees>
  diff: {
    /** 已经提交落盘的 checkpoint；Diff 的基准只从这里选。 */
    committed: CheckpointRecord[]
    baseSha: string | null
    setBase(sha: string | null): void
    text: string
    loading: boolean
    error: string | null
  }
  checkpoints: {
    list: CheckpointRecord[]
    error: string | null
    busy: boolean
    create(): Promise<void>
    restore(checkpointId: string): Promise<void>
  }
  pr: ReturnType<typeof usePullRequest>
}

export const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)

/** 读取当前 Workbench；只能在 WorkbenchPanel 里面用。 */
export function useWorkbench(): WorkbenchContextValue {
  const value = useContext(WorkbenchContext)
  if (!value) throw new Error("useWorkbench must be used inside WorkbenchPanel")
  return value
}
