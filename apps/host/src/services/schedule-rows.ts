/** 定时任务和运行历史在 SQLite 与协议之间的映射。 */
import {
  scheduleDraftSchema,
  scheduleExecutionSchema,
  scheduleRuleSchema,
  type Schedule,
  type ScheduleRun,
  type ScheduleRunStatus,
} from "@pigcode/contracts"

/** SQLite 中的任务行。 */
export interface ScheduleRow {
  id: string
  thread_id: string | null
  project_id: string | null
  execution_json: string | null
  title: string
  prompt: string
  draft_json: string | null
  rule_json: string
  ends_at: string | null
  enabled: number
  next_run_at: string | null
  last_run_at: string | null
  last_run_id: string | null
  run_count: number
  created_at: string
  updated_at: string
}

/** 运行历史一行，连同它启动的 run 的状态。 */
export interface ScheduleRunRow {
  id: string
  schedule_id: string
  source: "schedule" | "manual"
  status: "started" | "skipped" | "failed"
  run_id: string | null
  error: string | null
  triggered_at: string
  thread_id: string | null
  run_status: string | null
  completed_at: string | null
  error_message: string | null
}

/** 把数据库行映射为领域对象；没有下一次的任务已经过了结束日期。 */
export function mapSchedule(row: ScheduleRow): Schedule {
  const enabled = row.enabled === 1
  return {
    id: row.id,
    target:
      row.thread_id !== null
        ? { kind: "thread", threadId: row.thread_id }
        : {
            kind: "project",
            projectId: row.project_id!,
            execution: scheduleExecutionSchema.parse(JSON.parse(row.execution_json!)),
          },
    title: row.title,
    prompt: row.prompt,
    draft: row.draft_json ? scheduleDraftSchema.parse(JSON.parse(row.draft_json)) : null,
    rule: scheduleRuleSchema.parse(JSON.parse(row.rule_json)),
    endsAt: row.ends_at,
    enabled,
    status: row.next_run_at === null ? "completed" : enabled ? "active" : "paused",
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** 运行历史的一行：跳过与启动失败直接给出，启动了的看 run 自己的状态。 */
export function mapRun(row: ScheduleRunRow): ScheduleRun {
  let status: ScheduleRunStatus
  if (row.status === "skipped") status = "skipped"
  else if (row.status === "failed") status = "failed"
  else if (row.run_status === "completed") status = "succeeded"
  else if (row.run_status === "failed") status = "failed"
  else if (row.run_status === "interrupted") status = "stopped"
  else status = "running"
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    source: row.source,
    status,
    threadId: row.thread_id,
    runId: row.run_id,
    error: row.error ?? (status === "failed" ? row.error_message : null),
    triggeredAt: row.triggered_at,
    finishedAt: row.status === "started" ? row.completed_at : row.triggered_at,
  }
}
