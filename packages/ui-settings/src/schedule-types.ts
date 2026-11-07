/** 定时任务页与 Host 之间的数据：页面只认这些字段，RPC 由桌面端的容器完成。 */
import type { ScheduleRule } from "@pigcode/contracts"

/** 会话选项；只暴露选择器需要的字段。 */
export interface ScheduleThreadOption {
  id: string
  title: string
}

/** 创建任务的输入；与 schedule.create 命令参数一致。 */
export interface CreateScheduleInput {
  threadId: string
  title: string
  prompt: string
  rule: ScheduleRule
  endsAt: string | null
  enabled: boolean
}

/** 更新任务的输入；只提交变化的字段。 */
export interface UpdateScheduleInput {
  title?: string
  prompt?: string
  rule?: ScheduleRule
  endsAt?: string | null
  enabled?: boolean
}

/** 立即运行的结果：发出去了、会话正忙、Agent 不可用，或者发送失败。 */
export interface RunNowResult {
  status: "started" | "busy" | "unavailable" | "failed"
  runId: string | null
}
