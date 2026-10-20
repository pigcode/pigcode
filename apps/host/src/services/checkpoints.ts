/** 按 run 边界自动捕获 Git checkpoint，并提供手动创建与工作区恢复。 */
import type { Context } from "cordis"
import type { ThreadEvent } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"

/** checkpoint 的创建阶段；baseline/final 由 run 事件触发，manual 由用户触发。 */
export type CheckpointPhase = "baseline" | "final" | "manual"

/** 一次 checkpoint 的持久记录。 */
export interface Checkpoint {
  id: string
  threadId: string
  runId: string | null
  phase: CheckpointPhase
  gitRef: string
  commitSha: string | null
  label: string | null
  createdAt: string
}

/** 工作台需要的 checkpoint 操作。 */
export interface CheckpointsService {
  /** 按创建时间升序返回线程的全部 checkpoint。 */
  list(threadId: string): Checkpoint[]
  /** 手动捕获当前工作区；标签只用于展示。 */
  create(threadId: string, label?: string): Promise<Checkpoint>
  /** 恢复工作区到指定 checkpoint，返回受影响的路径。 */
  restore(threadId: string, checkpointId: string): Promise<string[]>
}

declare module "cordis" {
  interface Context {
    checkpoints: CheckpointsService
  }
}

/** checkpoints 插件依赖的服务。 */
export const inject = ["sessions", "storage", "git", "threads", "projects"]

/** checkpoints 插件函数，携带 Cordis 需要的 inject 元数据。 */
export interface CheckpointsPlugin {
  (ctx: Context): void
  inject: string[]
}

/** checkpoints 表的原始行。 */
interface CheckpointRow {
  id: string
  thread_id: string
  run_id: string | null
  phase: string
  git_ref: string
  commit_sha: string | null
  label: string | null
  created_at: string
}

/** 写入一条 checkpoint 行所需的数据。 */
interface CheckpointInput {
  id: string
  threadId: string
  runId: string | null
  phase: CheckpointPhase
  gitRef: string
  commitSha: string
  label: string | null
}

/** 注册 checkpoints 服务；所有 Git 操作串行执行，保证 baseline 先于 final。 */
export const apply: CheckpointsPlugin = (ctx) => {
  // 捕获是异步的；串行队列避免同一 run 的 final 抢在 baseline 之前落库。
  let pending: Promise<void> = Promise.resolve()

  /** 把任务排到队尾；调用方决定是否等待结果。 */
  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = pending.then(task)
    pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** 写 checkpoints 行并广播 checkpoint.created 事件。 */
  function store(input: CheckpointInput): Checkpoint {
    const createdAt = new Date().toISOString()
    ctx.storage.db
      .prepare(
        `INSERT INTO checkpoints (id, thread_id, run_id, phase, git_ref, commit_sha, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.threadId,
        input.runId,
        input.phase,
        input.gitRef,
        input.commitSha,
        input.label,
        createdAt,
      )
    const checkpoint: Checkpoint = {
      id: input.id,
      threadId: input.threadId,
      runId: input.runId,
      phase: input.phase,
      gitRef: input.gitRef,
      commitSha: input.commitSha,
      label: input.label,
      createdAt,
    }
    ctx.sessions.append({
      threadId: input.threadId,
      runId: input.runId,
      type: "checkpoint.created",
      payload: { checkpointId: checkpoint.id, runId: input.runId, phase: input.phase },
      schemaVersion: 1,
      createdAt,
    })
    return checkpoint
  }

  /** 自动捕获指定 run 的 checkpoint；非 git 项目等失败静默跳过。 */
  function schedule(threadId: string, runId: string, phase: CheckpointPhase): void {
    void serialize(async () => {
      const captured = await ctx.git.capture(threadId, runId, phase)
      store({
        id: `ck_${randomUUID()}`,
        threadId,
        runId,
        phase,
        gitRef: captured.ref,
        commitSha: captured.commitSha,
        label: null,
      })
    }).catch(() => undefined)
  }

  /** run 事件到自动 checkpoint 阶段的映射；其余事件忽略。 */
  function onEvent(event: ThreadEvent): void {
    if (event.runId === null) return
    if (event.type === "run.started") schedule(event.threadId, event.runId, "baseline")
    if (isTerminal(event.type)) schedule(event.threadId, event.runId, "final")
  }

  const service: CheckpointsService = {
    list(threadId) {
      const rows = ctx.storage.db
        .prepare(
          `SELECT id, thread_id, run_id, phase, git_ref, commit_sha, label, created_at
           FROM checkpoints WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC`,
        )
        .all(threadId) as CheckpointRow[]
      return rows.map((row) => ({
        id: row.id,
        threadId: row.thread_id,
        runId: row.run_id,
        phase: row.phase as CheckpointPhase,
        gitRef: row.git_ref,
        commitSha: row.commit_sha,
        label: row.label,
        createdAt: row.created_at,
      }))
    },
    create(threadId, label) {
      return serialize(async () => {
        const id = `ck_${randomUUID()}`
        // 手动 checkpoint 没有 run；用 id 构造唯一 ref 段，避免覆盖历史快照。
        const captured = await ctx.git.capture(threadId, `manual-${id}`, "manual")
        return store({
          id,
          threadId,
          runId: null,
          phase: "manual",
          gitRef: captured.ref,
          commitSha: captured.commitSha,
          label: label ?? null,
        })
      })
    },
    restore(threadId, checkpointId) {
      return serialize(async () => {
        const row = ctx.storage.db
          .prepare(
            `SELECT id, thread_id, run_id, phase, git_ref, commit_sha, label, created_at
             FROM checkpoints WHERE id = ? AND thread_id = ?`,
          )
          .get(checkpointId, threadId) as CheckpointRow | undefined
        if (!row) throw new Error(`checkpoint not found: ${checkpointId}`)
        if (!row.commit_sha) throw new Error(`checkpoint has no commit: ${checkpointId}`)

        const affected = await ctx.git.restore(threadId, row.commit_sha)
        ctx.sessions.append({
          threadId,
          runId: null,
          type: "thread.updated",
          payload: { restored: checkpointId },
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
        })
        return affected
      })
    },
  }

  ctx.provide("checkpoints", service)
  const unsubscribe = ctx.sessions.subscribeAll(onEvent)
  ctx.effect(() => () => unsubscribe())
}

apply.inject = inject

/** run 的三个终态事件都会触发 final checkpoint。 */
function isTerminal(type: ThreadEvent["type"]): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.interrupted"
}
