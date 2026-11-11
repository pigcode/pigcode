/**
 * 会话条目（thread_items）：从事件日志投影出来的对话历史，一条消息、一次工具调用、一份计划各一行。
 * 交接挑选、pigcode_thread_read 分页和增量判断都读这张表，不再每次重放整个事件日志。
 * 事件日志仍然是源头：条目和事件在同一个事务里写入，迁移时从事件日志回填。
 */
import type { ThreadEvent } from "@pigcode/contracts"
import type Database from "better-sqlite3"

/** 条目的种类。tool 是读文件、搜索这类不改东西的工具；command 和 file_change 单独分出来，交接要用。 */
export type ThreadItemKind =
  | "user_message"
  | "assistant_message"
  | "command"
  | "file_change"
  | "tool"
  | "subagent"
  | "plan"
  | "error"
  | "interrupt"

/** 一条会话条目。 */
export interface ThreadItem {
  id: string
  threadId: string
  /** 会话里的位置：第一条相关事件的 seq，单调递增。 */
  position: number
  kind: ThreadItemKind
  runId: string | null
  agentId: string | null
  instanceId: string | null
  agentSessionId: string | null
  /** 子 agent 内部的条目带着父工具调用 id；主会话的条目为 null。 */
  parentToolUseId: string | null
  /** completed、failed、running、interrupted，或者中断时留下的半截回答 partial。 */
  status: string
  /** 给人和 agent 读的文本：消息原文，或者「命令 + 退出码 + 输出」这样的渲染结果。 */
  text: string
}

/** 交接和读取会用到的工具名。 */
const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "shell", "local_shell"])
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "ApplyPatch"])
const SUBAGENT_TOOLS = new Set(["Task", "Agent"])

type Row = Record<string, unknown>

/** 把一条刚写入的事件投影到条目表；和事件写在同一个事务里调用。 */
export function projectThreadItem(db: Database.Database, event: ThreadEvent): void {
  const payload = (event.payload ?? {}) as Row
  const parent = typeof payload.parentToolUseId === "string" ? payload.parentToolUseId : null
  switch (event.type) {
    case "message.completed": {
      const role = payload.role
      const text = typeof payload.text === "string" ? payload.text : ""
      if ((role !== "user" && role !== "assistant") || text.trim() === "") return
      insert(db, event, {
        id: `msg:${event.seq}`,
        kind: role === "user" ? "user_message" : "assistant_message",
        status: payload.partial === true ? "partial" : "completed",
        text,
        parent,
        data: {},
      })
      return
    }
    case "tool.started": {
      const callId = callIdOf(payload)
      const name = typeof payload.name === "string" ? payload.name : "tool"
      if (!callId) return
      const kind = toolKind(name)
      insert(db, event, {
        id: toolItemId(event, callId),
        kind,
        status: "running",
        text: renderTool(kind, name, payload.input, undefined, undefined),
        parent,
        data: { name, input: payload.input },
      })
      return
    }
    case "tool.completed": {
      const callId = callIdOf(payload)
      if (!callId) return
      const id = toolItemId(event, callId)
      const existing = db
        .prepare(`SELECT payload_json, kind FROM thread_items WHERE id = ?`)
        .get(id) as { payload_json: string; kind: ThreadItemKind } | undefined
      const name = typeof payload.name === "string" ? payload.name : "tool"
      // 只有 completed 没有 started（旧数据、迟到的事件）时也补一条。
      const started = existing
        ? (JSON.parse(existing.payload_json) as Row)
        : { name, input: undefined }
      const kind = existing?.kind ?? toolKind(name)
      const exitCode = typeof payload.exitCode === "number" ? payload.exitCode : undefined
      const status = payload.isError === true ? "failed" : "completed"
      const text = renderTool(
        kind,
        String(started.name ?? name),
        started.input,
        payload.output,
        exitCode,
      )
      if (!existing) {
        insert(db, event, { id, kind, status, text, parent, data: started })
        return
      }
      db.prepare(`UPDATE thread_items SET status = ?, text = ?, updated_seq = ? WHERE id = ?`).run(
        status,
        text,
        event.seq,
        id,
      )
      return
    }
    case "subagent.started": {
      const callId = callIdOf(payload)
      if (!callId) return
      const description = [payload.description, payload.prompt]
        .filter((part): part is string => typeof part === "string" && part.trim() !== "")
        .join("\n")
      insert(db, event, {
        id: toolItemId(event, callId),
        kind: "subagent",
        status: "running",
        text: `Sub-agent: ${description}`.trim(),
        parent,
        data: { name: payload.name, description },
      })
      return
    }
    case "subagent.completed": {
      const callId = callIdOf(payload)
      if (!callId) return
      const id = toolItemId(event, callId)
      const existing = db.prepare(`SELECT text FROM thread_items WHERE id = ?`).get(id) as
        { text: string } | undefined
      if (!existing) return
      const output = stringify(payload.output)
      const status = typeof payload.status === "string" ? payload.status : "completed"
      db.prepare(`UPDATE thread_items SET status = ?, text = ?, updated_seq = ? WHERE id = ?`).run(
        status,
        output ? `${existing.text}\nResult:\n${output}` : existing.text,
        event.seq,
        id,
      )
      return
    }
    case "plan.updated": {
      const text = renderPlan(payload.plan, payload.explanation)
      if (!text) return
      insert(db, event, {
        id: `plan:${event.seq}`,
        kind: "plan",
        status: "completed",
        text,
        parent,
        data: {},
      })
      return
    }
    case "run.failed": {
      const message = typeof payload.message === "string" ? payload.message : ""
      if (!message) return
      insert(db, event, {
        id: `error:${event.seq}`,
        kind: "error",
        status: "failed",
        text: message,
        parent: null,
        data: {},
      })
      return
    }
    case "run.interrupted":
      insert(db, event, {
        id: `interrupt:${event.seq}`,
        kind: "interrupt",
        status: "interrupted",
        text: "The user interrupted this turn.",
        parent: null,
        data: {},
      })
      return
    default:
      return
  }
}

/**
 * 迁移时从事件日志回填全部条目；按 seq 顺序重放，和实时写入走同一套投影。
 * 一批批读：better-sqlite3 在一条查询还在迭代时不能写。
 */
export function backfillThreadItems(db: Database.Database, batch = 2000): void {
  const read = db.prepare(
    `SELECT seq, thread_id, run_id, type, payload_json, schema_version, created_at
     FROM thread_events
     WHERE seq > ? AND type IN ('message.completed', 'tool.started', 'tool.completed',
       'subagent.started', 'subagent.completed', 'plan.updated', 'run.failed', 'run.interrupted')
     ORDER BY seq ASC LIMIT ?`,
  )
  let after = 0
  for (;;) {
    const rows = read.all(after, batch) as Row[]
    for (const row of rows) projectThreadItem(db, eventOf(row))
    if (rows.length < batch) return
    after = rows.at(-1)!.seq as number
  }
}

/** 会话条目的读取入口。 */
export class ThreadItemStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * 按位置分页读一个会话的条目。默认不含子 agent 内部的条目。
   */
  list(
    threadId: string,
    options: {
      afterPosition?: number
      beforePosition?: number
      limit?: number
      kinds?: readonly ThreadItemKind[]
      includeSubagents?: boolean
      excludeRunId?: string
    } = {},
  ): ThreadItem[] {
    const where = ["thread_id = ?", "position > ?"]
    const params: unknown[] = [threadId, options.afterPosition ?? 0]
    if (options.beforePosition !== undefined) {
      where.push("position < ?")
      params.push(options.beforePosition)
    }
    if (!options.includeSubagents) where.push("parent_tool_use_id IS NULL")
    if (options.kinds && options.kinds.length > 0) {
      where.push(`kind IN (${options.kinds.map(() => "?").join(", ")})`)
      params.push(...options.kinds)
    }
    if (options.excludeRunId !== undefined) {
      where.push("(run_id IS NULL OR run_id != ?)")
      params.push(options.excludeRunId)
    }
    const limit =
      options.limit === undefined ? "" : ` LIMIT ${Math.max(0, Math.floor(options.limit))}`
    const rows = this.db
      .prepare(
        `SELECT * FROM thread_items WHERE ${where.join(" AND ")} ORDER BY position ASC${limit}`,
      )
      .all(...params) as Row[]
    return rows.map(mapItem)
  }

  /** 读一条条目；不存在时返回 undefined。 */
  get(threadId: string, itemId: string): ThreadItem | undefined {
    const row = this.db
      .prepare(`SELECT * FROM thread_items WHERE thread_id = ? AND id = ?`)
      .get(threadId, itemId) as Row | undefined
    return row ? mapItem(row) : undefined
  }

  /** 这个 Agent 会话最后参与到哪个位置：它写下的最后一条条目；没参与过时为 null。 */
  lastPositionOfSession(threadId: string, agentSessionId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(position) AS position FROM thread_items
         WHERE thread_id = ? AND agent_session_id = ?`,
      )
      .get(threadId, agentSessionId) as { position: number | null }
    return row.position ?? null
  }

  /** 会话里最后一条条目的位置；还没有条目时为 0。 */
  lastPosition(threadId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(position) AS position FROM thread_items WHERE thread_id = ?`)
      .get(threadId) as { position: number | null }
    return row.position ?? 0
  }
}

function insert(
  db: Database.Database,
  event: ThreadEvent,
  item: {
    id: string
    kind: ThreadItemKind
    status: string
    text: string
    parent: string | null
    data: Row
  },
): void {
  const agent = event.runId ? runAgent(db, event.runId) : null
  db.prepare(
    `INSERT OR REPLACE INTO thread_items
       (id, thread_id, position, kind, run_id, agent_id, instance_id, agent_session_id,
        parent_tool_use_id, status, text, payload_json, updated_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    event.threadId,
    event.seq,
    item.kind,
    event.runId,
    agent?.agentId ?? null,
    agent?.instanceId ?? null,
    agent?.agentSessionId ?? null,
    item.parent,
    item.status,
    item.text,
    JSON.stringify(item.data),
    event.seq,
  )
}

/**
 * 这一轮是哪个 Agent 实例、哪个会话跑的：runs 记着 agent_session_id，会话行记着 Agent 和实例。
 * 用户消息写在会话建好之前，读到的是 null。
 */
function runAgent(
  db: Database.Database,
  runId: string,
): { agentId: string | null; instanceId: string | null; agentSessionId: string | null } | null {
  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.agent_id, COALESCE(s.instance_id, s.agent_id) AS instance_id
       FROM runs r JOIN agent_sessions s ON s.id = r.agent_session_id
       WHERE r.id = ?`,
    )
    .get(runId) as { session_id: string; agent_id: string; instance_id: string } | undefined
  if (!row) return null
  return { agentId: row.agent_id, instanceId: row.instance_id, agentSessionId: row.session_id }
}

function toolKind(name: string): ThreadItemKind {
  if (COMMAND_TOOLS.has(name)) return "command"
  if (FILE_TOOLS.has(name)) return "file_change"
  if (SUBAGENT_TOOLS.has(name)) return "subagent"
  return "tool"
}

/** 工具调用条目的 id：同一个调用 id 只在一轮里唯一（测试替身、某些 CLI 每轮从头编号），所以带上 run。 */
function toolItemId(event: ThreadEvent, callId: string): string {
  return `tool:${event.runId ?? event.threadId}:${callId}`
}

function callIdOf(payload: Row): string | null {
  const id = payload.toolCallId ?? payload.id
  return typeof id === "string" && id.length > 0 ? id : null
}

/** 工具调用的文本：命令写命令、退出码和输出；改文件只写路径；其他工具写名字、参数和输出。 */
function renderTool(
  kind: ThreadItemKind,
  name: string,
  input: unknown,
  output: unknown,
  exitCode: number | undefined,
): string {
  const out = stringify(output)
  if (kind === "command") {
    return [
      `Command: ${commandOf(input)}`,
      ...(output === undefined ? [] : [`Exit code: ${exitCode ?? "unknown"}`]),
      ...(out ? [out] : []),
    ].join("\n")
  }
  if (kind === "file_change") {
    const paths = pathsOf(input)
    return `File change: ${paths.length > 0 ? paths.join(", ") : name}`
  }
  return [`Tool: ${name} ${stringify(input)}`.trim(), ...(out ? [out] : [])].join("\n")
}

function commandOf(input: unknown): string {
  if (typeof input === "string") return input
  if (input && typeof input === "object") {
    const command = (input as Row).command
    if (typeof command === "string") return command
    if (Array.isArray(command)) return command.join(" ")
  }
  return stringify(input)
}

/** 改文件的路径：Claude 的 file_path / notebook_path，Codex ApplyPatch 的 changes[].path。 */
function pathsOf(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((change) => (change && typeof change === "object" ? (change as Row).path : undefined))
      .filter((path): path is string => typeof path === "string")
  }
  if (input && typeof input === "object") {
    const record = input as Row
    for (const key of ["file_path", "notebook_path", "path"]) {
      if (typeof record[key] === "string") return [record[key] as string]
    }
    if (Array.isArray(record.changes)) return pathsOf(record.changes)
  }
  return []
}

function renderPlan(plan: unknown, explanation: unknown): string {
  const steps = Array.isArray(plan)
    ? plan.map((step) => {
        if (typeof step === "string") return `- ${step}`
        const record = (step ?? {}) as Row
        const text = record.step ?? record.content ?? record.title ?? ""
        const status = typeof record.status === "string" ? ` [${record.status}]` : ""
        return `- ${String(text)}${status}`
      })
    : []
  const head = typeof explanation === "string" && explanation.trim() !== "" ? [explanation] : []
  return steps.length === 0 && head.length === 0 ? "" : ["Plan:", ...head, ...steps].join("\n")
}

function stringify(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    // MCP / SDK 的工具结果常是 [{ type: "text", text }]。
    const texts = value
      .map((part) => (part && typeof part === "object" ? (part as Row).text : undefined))
      .filter((text): text is string => typeof text === "string")
    if (texts.length === value.length && texts.length > 0) return texts.join("\n")
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function eventOf(row: Row): ThreadEvent {
  return {
    seq: row.seq as number,
    threadId: row.thread_id as string,
    runId: (row.run_id as string | null) ?? null,
    type: row.type as ThreadEvent["type"],
    payload: JSON.parse(row.payload_json as string) as unknown,
    schemaVersion: 1,
    createdAt: row.created_at as string,
  }
}

function mapItem(row: Row): ThreadItem {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    position: row.position as number,
    kind: row.kind as ThreadItemKind,
    runId: (row.run_id as string | null) ?? null,
    agentId: (row.agent_id as string | null) ?? null,
    instanceId: (row.instance_id as string | null) ?? null,
    agentSessionId: (row.agent_session_id as string | null) ?? null,
    parentToolUseId: (row.parent_tool_use_id as string | null) ?? null,
    status: row.status as string,
    text: row.text as string,
  }
}
