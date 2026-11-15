/** 定时任务页与 Host 之间的数据：页面只认这些字段，RPC 由桌面端的容器完成。 */
import type { AgentCommand, CommandParams, Thread, WorktreeStart } from "@pigcode/contracts"
import type {
  ComposerAgent,
  ComposerModelCatalog,
  ComposerThreadOption,
} from "@pigcode/ui-composer"
import type { ReactNode } from "react"

/** 旧任务还需要显示已绑定的会话。 */
export type ScheduleThreadOption = Pick<Thread, "id" | "title"> &
  Partial<
    Pick<
      Thread,
      | "projectId"
      | "defaultInstanceId"
      | "lastInstanceId"
      | "lastModelId"
      | "permissionMode"
      | "planMode"
    >
  >

export type CreateScheduleInput = CommandParams<"schedule.create">
export type UpdateScheduleInput = Omit<CommandParams<"schedule.update">, "id">

/** 运行设置使用与新会话相同的 Agent 实例与模型目录。 */
export interface ScheduleAgentOptions {
  agents: readonly ComposerAgent[]
  defaultInstanceId?: string | null | undefined
  catalog: ComposerModelCatalog
  onLoadModels?: (instanceId: string) => void
}

export interface ScheduleComposerSources {
  listFiles?: (projectId: string) => Promise<readonly string[]>
  threadOptions?: (
    projectId: string | null,
    threadId: string | null,
  ) => readonly ComposerThreadOption[]
  loadCommands?: (
    instanceId: string,
    scope: { threadId: string } | { projectId: string } | null,
    refresh?: boolean,
  ) => Promise<AgentCommand[]>
  workspaceControls?: (props: ScheduleWorkspaceControlsProps) => ReactNode
}

export interface ScheduleWorkspaceControlsProps {
  projectId: string
  worktree?: WorktreeStart | undefined
  onWorktree: (worktree: WorktreeStart | null) => void
  disabled: boolean
}

/** 立即运行的结果：启动了、已有一轮进行中、Agent 不可用、启动失败。 */
export interface RunNowResult {
  status: "started" | "busy" | "unavailable" | "failed"
  runId: string | null
}
