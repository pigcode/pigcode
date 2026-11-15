/** 定时任务页与 Host 之间的数据：页面只认这些字段，RPC 由桌面端的容器完成。 */
import type { CommandParams } from "@pigcode/contracts"
import type { ComposerAgent, ComposerModelCatalog } from "@pigcode/ui-composer"

/** 旧任务还需要显示已绑定的会话。 */
export interface ScheduleThreadOption {
  id: string
  title: string
}

export type CreateScheduleInput = CommandParams<"schedule.create">
export type UpdateScheduleInput = Omit<CommandParams<"schedule.update">, "id">

/** 运行设置使用与新会话相同的 Agent 实例与模型目录。 */
export interface ScheduleAgentOptions {
  agents: readonly ComposerAgent[]
  catalog: ComposerModelCatalog
  onLoadModels?: (instanceId: string) => void
}

/** 立即运行的结果：启动了、已有一轮进行中、Agent 不可用、启动失败。 */
export interface RunNowResult {
  status: "started" | "busy" | "unavailable" | "failed"
  runId: string | null
}
