import {
  mobileRunChangesMethods as methods,
  mobileRunChangedFile,
  mobileRunChangesPage,
  mobileRunChangesParams,
  mobileRunDiffPage,
  mobileRunDiffParams,
  type MobileRunChangedFile,
  type MobileRunChangesParams,
  type MobileRunDiffParams,
  type RpcRequest,
} from "@pigcode/contracts"
import { isAbsolute, relative, resolve, sep } from "node:path"
import type { Context } from "cordis"
import { readCheckpointChanges, readCheckpointPatch, workspaceRange, type CheckpointRange } from "../services/checkpoint-diff"
import { RunStore } from "../storage/run-store"
import { requireMobileThread } from "./command-receipts"
import { mobileParams, MobileRequestError } from "./request-error"

const maxFilesPerPage = 64
const pageBytes = 48 * 1024

export const mobileRunChangesRequests: ReadonlySet<string> = new Set(Object.values(methods))

export class MobileRunChanges {
  private readonly runs: RunStore

  constructor(private readonly ctx: Context) {
    this.runs = new RunStore(ctx.storage.db)
  }

  dispatch(request: RpcRequest): unknown {
    switch (request.method) {
      case methods.list:
        return this.list(mobileParams(mobileRunChangesParams, request.params))
      case methods.diff:
        return this.patch(mobileParams(mobileRunDiffParams, request.params))
      default:
        throw new MobileRequestError("METHOD_NOT_AVAILABLE")
    }
  }

  private scope(threadId: string, runId: string) {
    requireMobileThread(this.ctx, threadId)
    if (this.runs.get(runId)?.threadId !== threadId) {
      throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    }
    const pair = this.ctx.get("checkpoints")?.runSnapshots(threadId, runId)
    const cwd = pair?.workspace?.cwd ?? this.sessionCwd(threadId, runId)
    const shared = pair?.sharedWorktree || (
      !pair?.workspace && cwd && pair?.baselineAt && pair.finalAt &&
      this.sharedLegacyWorkspace(runId, cwd, pair.baselineAt, pair.finalAt)
    )
    let range: CheckpointRange | undefined
    if (!shared && pair?.before && pair.after) {
      if (pair.workspace) range = workspaceRange(pair.workspace, pair.before, pair.after)
      else if (cwd && this.canReadLegacySnapshots(threadId, cwd)) {
        range = { cwd, before: pair.before, after: pair.after }
      }
    }
    return { range, cwd, shared: !!shared }
  }

  private canReadLegacySnapshots(threadId: string, cwd: string): boolean {
    const thread = this.ctx.threads.get(threadId)
    const project = thread && this.ctx.projects.get(thread.projectId)
    // Old checkpoint rows do not record which working tree they captured.
    return project?.rootPath === cwd && !this.ctx.storage.db.prepare(
      "SELECT 1 FROM worktrees WHERE thread_id = ? LIMIT 1",
    ).get(threadId)
  }

  private sessionCwd(threadId: string, runId: string): string | undefined {
    const row = this.ctx.storage.db.prepare(
      `SELECT s.cwd FROM runs r JOIN agent_sessions s ON s.id = r.agent_session_id
       WHERE r.id = ? AND r.thread_id = ?`,
    ).get(runId, threadId) as { cwd: string } | undefined
    return row?.cwd
  }

  private sharedLegacyWorkspace(runId: string, cwd: string, from: string, to: string): boolean {
    return !!this.ctx.storage.db.prepare(
      `SELECT 1 FROM runs r JOIN agent_sessions s ON s.id = r.agent_session_id
       JOIN thread_events e ON e.thread_id = r.thread_id AND e.run_id = r.id
       WHERE r.id <> ? AND s.cwd = ? AND e.type = 'run.started' AND e.created_at < ?
         AND (r.completed_at IS NULL OR r.completed_at > ?) LIMIT 1`,
    ).get(runId, cwd, to, from)
  }

  private async list({ threadId, runId, offset = 0 }: MobileRunChangesParams) {
    const { range, cwd, shared } = this.scope(threadId, runId)
    const files = range ? await readCheckpointChanges(range).catch(() => undefined) : undefined
    requireMobileThread(this.ctx, threadId)
    return mobileRunChangesPage.parse({
      ...pageFiles(files ?? this.savedFiles(threadId, runId, cwd), offset),
      diffAvailable: files !== undefined,
      ...(shared ? { sharedWorktree: true } : {}),
    })
  }

  private async patch({ threadId, runId, path, offset = 0 }: MobileRunDiffParams) {
    const { range } = this.scope(threadId, runId)
    if (!range) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    const files = await readCheckpointChanges(range, path).catch(() => [])
    if (!files.some((file) => file.path === path)) throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    const patch = await readCheckpointPatch(range, path, offset).catch(() => {
      throw new MobileRequestError("RESOURCE_NOT_AVAILABLE")
    })
    if (!patch) throw new MobileRequestError("INVALID_PARAMS")
    requireMobileThread(this.ctx, threadId)
    return mobileRunDiffPage.parse(patch)
  }

  private savedFiles(threadId: string, runId: string, cwd?: string): MobileRunChangedFile[] {
    const base = resolve(cwd ?? sep)
    const paths = new Set<string>()
    const add = (value: unknown) => {
      if (typeof value !== "string" || value.includes("\0")) return
      if (!cwd && (isAbsolute(value) || value.split(/[\\/]/).includes(".."))) return
      const path = relative(base, resolve(base, value))
      if (!path || isAbsolute(path) || path === ".." || path.startsWith(".." + sep)) return
      const file = mobileRunChangedFile.safeParse({ path: path.split(sep).join("/") })
      if (file.success) paths.add(file.data.path)
    }
    const events = this.ctx.storage.events
    for (const event of events.readRunEvents(threadId, runId, "checkpoint.created")) {
      const payload = event.payload as { changedPaths?: unknown } | null
      if (Array.isArray(payload?.changedPaths)) payload.changedPaths.forEach(add)
    }
    for (const event of events.readRunEvents(threadId, runId, "file.changed")) {
      add((event.payload as { path?: unknown } | null)?.path)
    }
    return [...paths].sort().map((path) => ({ path }))
  }
}

function pageFiles(all: MobileRunChangedFile[], offset: number) {
  if (offset > all.length) throw new MobileRequestError("INVALID_PARAMS")
  const files: MobileRunChangedFile[] = []
  let bytes = 2
  for (const file of all.slice(offset, offset + maxFilesPerPage)) {
    bytes += Buffer.byteLength(JSON.stringify(file)) + 1
    if (bytes > pageBytes) break
    files.push(file)
  }
  const next = offset + files.length
  return { files, ...(next < all.length ? { nextOffset: next } : {}) }
}
