/** 按 run 边界自动捕获 Git checkpoint，并提供手动创建与工作区恢复。 */
import type { Context } from "cordis"
import type { ThreadEvent } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import { checkpointWorkspace, readCheckpointPaths, workspaceRange, type CheckpointWorkspace } from "./checkpoint-diff"
import { capture } from "./git"
import { threadCwd } from "./worktrees"

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
  /** 返回同一轮的起点和终点提交。 */
  runSnapshots(threadId: string, runId: string): RunSnapshots
  /** 在启动 Agent 之前捕获本轮起点。 */
  captureBaseline(threadId: string, runId: string, cwd: string, signal: AbortSignal): Promise<void>
  trackExecution(runId: string, settled: Promise<void>): void
  waitForFinal(runId: string): Promise<void> | undefined
  abandonBaseline(runId: string): void
  moveExecution(runId: string, cwd: string, signal: AbortSignal): Promise<void>
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
  changedPaths?: string[]
  workspace?: CheckpointWorkspace
  sharedWorktree?: boolean
}

interface RunSnapshots {
  before?: string
  after?: string
  workspace?: CheckpointWorkspace
  sharedWorktree?: boolean
  baselineAt?: string
  finalAt?: string
}

interface TrackedRun {
  workspace: CheckpointWorkspace
  sharedWorktree: boolean
  settled?: Promise<void>
  final?: Promise<void>
  unbased?: boolean
}

async function untilAbort<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void task.catch(() => undefined)
    signal.throwIfAborted()
  }
  let abort!: () => void
  const cancellation = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
  })
  try {
    return await Promise.race([task, cancellation])
  } finally {
    signal.removeEventListener("abort", abort)
  }
}

/** 同一工作树的捕获依次执行，独立工作树可并行。 */
export const apply: CheckpointsPlugin = (ctx) => {
  const queues = new Map<string, Promise<void>>()
  const active = new Map<string, TrackedRun>()

  /** 把任务排到队尾；调用方决定是否等待结果。 */
  function serialize<T>(key: string, task: () => Promise<T>): Promise<T> {
    const result = (queues.get(key) ?? Promise.resolve()).then(task)
    const pending = result.then(
      () => undefined,
      () => undefined,
    )
    queues.set(key, pending)
    void pending.then(() => {
      if (queues.get(key) === pending) queues.delete(key)
    })
    return result
  }

  function runSnapshots(threadId: string, runId: string): RunSnapshots {
    const rows = ctx.storage.db.prepare(
      `SELECT id, phase, commit_sha, created_at FROM checkpoints WHERE thread_id = ? AND run_id = ?
       ORDER BY rowid ASC`,
    ).all(threadId, runId) as Pick<CheckpointRow, "id" | "phase" | "commit_sha" | "created_at">[]
    const baseline = rows.find((row) => row.phase === "baseline")
    const final = rows.filter((row) => row.phase === "final").at(-1)
    const result: RunSnapshots = baseline?.commit_sha
      ? { before: baseline.commit_sha, baselineAt: baseline.created_at }
      : {}
    if (!final?.commit_sha) return result
    result.after = final.commit_sha
    result.finalAt = final.created_at
    for (const event of ctx.storage.events.readRunEvents(threadId, runId, "checkpoint.created")) {
      const payload = event.payload as Partial<CheckpointInput> & { checkpointId?: unknown } | null
      if (payload?.checkpointId === final.id) {
        if (payload.workspace) result.workspace = payload.workspace
        if (payload.sharedWorktree === true) result.sharedWorktree = true
        break
      }
    }
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
      payload: {
        checkpointId: checkpoint.id, runId: input.runId, phase: input.phase,
        ...(input.changedPaths ? { changedPaths: input.changedPaths } : {}),
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.sharedWorktree ? { sharedWorktree: true } : {}),
      },
      schemaVersion: 1,
      createdAt,
    })
    return checkpoint
  }

  function activate(runId: string, run: TrackedRun): void {
    if (active.has(runId)) return
    for (const other of active.values()) {
      if (other.workspace.root !== run.workspace.root) continue
      other.sharedWorktree = true
      run.sharedWorktree = true
    }
    active.set(runId, run)
  }

  async function captureBaseline(threadId: string, runId: string, cwd: string, cancel: AbortSignal) {
    const signal = AbortSignal.any([cancel, AbortSignal.timeout(8_000)])
    const workspace = await untilAbort(checkpointWorkspace(cwd, signal), signal).catch(() => undefined)
    if (!workspace || cancel.aborted) return
    const run: TrackedRun = { workspace, sharedWorktree: false }
    const job = serialize(workspace.root, async () => {
      signal.throwIfAborted()
      activate(runId, run)
      const captured = await capture(cwd, threadId, runId, "baseline", signal)
      signal.throwIfAborted()
      store({ id: `ck_${randomUUID()}`, threadId, runId, phase: "baseline",
        gitRef: captured.ref, commitSha: captured.commitSha, label: null })
    })
    await untilAbort(job, signal).catch(() => undefined)
    // Even when baseline capture timed out, this run's writes may overlap another run.
    if (!cancel.aborted) activate(runId, run)
  }

  /** Register the final job at publication, then wait for native execution to settle. */
  function onEvent(event: ThreadEvent): void {
    const { threadId, runId } = event
    if (!runId || !isTerminal(event.type)) return
    const run = active.get(runId)
    const settled = run?.settled
    if (!run || !settled || run.final) return
    const { workspace } = run
    const signal = AbortSignal.timeout(12_000)
    run.final = serialize(workspace.root, async () => {
      let nativeSettled = false
      try {
        await untilAbort(settled, signal)
        nativeSettled = true
        const before = run.unbased ? undefined : runSnapshots(threadId, runId).before
        if (!before) return
        const saved = await capture(workspace.cwd, threadId, runId, "final", signal)
        const changedPaths = run.sharedWorktree ? undefined : await readCheckpointPaths(
          workspaceRange(workspace, before, saved.commitSha),
        ).catch(() => undefined)
        store({ id: `ck_${randomUUID()}`, threadId, runId, phase: "final",
          gitRef: saved.ref, commitSha: saved.commitSha, label: null, workspace,
          sharedWorktree: run.sharedWorktree,
          ...(changedPaths && !run.sharedWorktree ? { changedPaths } : {}) })
      } finally {
        // Release the window before the next queued baseline starts. A timed-out
        // native turn can still modify this worktree until its driver settles.
        if (nativeSettled) active.delete(runId)
        else void settled.then(() => active.delete(runId))
      }
    }).catch(() => undefined)
  }

  async function workspaceKey(threadId: string) {
    const cwd = threadCwd(ctx, threadId)
    const workspace = await checkpointWorkspace(cwd, AbortSignal.timeout(2_000)).catch(() => undefined)
    return workspace?.root ?? cwd
  }

  const service: CheckpointsService = {
    runSnapshots,
    captureBaseline,
    trackExecution(runId, settled) {
      const run = active.get(runId)
      if (run) run.settled = settled
    },
    waitForFinal: (runId) => active.get(runId)?.final,
    abandonBaseline: (runId) => { active.delete(runId) },
    async moveExecution(runId, cwd, cancel) {
      const run = active.get(runId)
      if (!run) return
      const signal = AbortSignal.any([cancel, AbortSignal.timeout(2_000)])
      const workspace = await untilAbort(checkpointWorkspace(cwd, signal), signal).catch(() => undefined)
      active.delete(runId)
      if (workspace && !cancel.aborted) activate(runId, { ...run, workspace, unbased: true })
    },
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
    async create(threadId, label) {
      return serialize(await workspaceKey(threadId), async () => {
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
    async restore(threadId, checkpointId) {
      return serialize(await workspaceKey(threadId), async () => {
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
