import { randomUUID } from "node:crypto"
import type { StartRunOptions } from "../agents/service"
import type { PigcodeDatabase } from "./database"

export interface QueueDeviceSource {
  deviceKey: string
  authorizationId: string
}

export interface StoredQueuedMessage {
  id: string
  threadId: string
  runId: string
  text: string
  options: Omit<StartRunOptions, "admission">
  source?: QueueDeviceSource
}

interface MessageRow {
  id: string
  thread_id: string
  run_id: string
  text: string
  options_json: string
  device_key: string | null
  authorization_id: string | null
}

interface QueueState {
  paused: boolean
  selectedId: string | null
  stopTargetId: string | null
  actionSource?: QueueDeviceSource
}

function message(row: MessageRow): StoredQueuedMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    text: row.text,
    options: JSON.parse(row.options_json) as StoredQueuedMessage["options"],
    ...(row.device_key && row.authorization_id
      ? { source: { deviceKey: row.device_key, authorizationId: row.authorization_id } }
      : {}),
  }
}

export class QueuedMessageStore {
  constructor(private readonly db: PigcodeDatabase) {}

  list(threadId: string): StoredQueuedMessage[] {
    return (
      this.db
        .prepare(`SELECT * FROM queued_messages WHERE thread_id = ? ORDER BY seq`)
        .all(threadId) as MessageRow[]
    ).map(message)
  }

  byDevice(deviceKey: string): StoredQueuedMessage[] {
    return (
      this.db
        .prepare(`SELECT * FROM queued_messages WHERE device_key = ?`)
        .all(deviceKey) as MessageRow[]
    ).map(message)
  }

  actionsByDevice(deviceKey: string): string[] {
    const rows = this.db
      .prepare(`SELECT thread_id FROM message_queue_state WHERE action_device_key = ?`)
      .all(deviceKey) as { thread_id: string }[]
    return rows.map(({ thread_id }) => thread_id)
  }

  add(
    threadId: string,
    text: string,
    options: StoredQueuedMessage["options"],
    source?: QueueDeviceSource,
  ) {
    const id = `qm_${randomUUID()}`
    const runId = `run_${randomUUID()}`
    this.db
      .prepare(
        `INSERT INTO queued_messages
      (id, thread_id, run_id, text, options_json, device_key, authorization_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        threadId,
        runId,
        text,
        JSON.stringify(options),
        source?.deviceKey ?? null,
        source?.authorizationId ?? null,
      )
    return { id, runId }
  }

  remove(threadId: string, id: string): boolean {
    const removed =
      this.db
        .prepare(`DELETE FROM queued_messages WHERE thread_id = ? AND id = ?`)
        .run(threadId, id).changes === 1
    if (removed) {
      this.db
        .prepare(
          `DELETE FROM message_queue_state WHERE thread_id = ?
        AND NOT EXISTS (SELECT 1 FROM queued_messages WHERE thread_id = ?)`,
        )
        .run(threadId, threadId)
    }
    return removed
  }

  state(threadId: string): QueueState {
    const row = this.db
      .prepare(`SELECT * FROM message_queue_state WHERE thread_id = ?`)
      .get(threadId) as
      | {
          paused: number
          selected_id: string | null
          stop_target_id: string | null
          action_device_key: string | null
          action_authorization_id: string | null
        }
      | undefined
    return {
      paused: row?.paused === 1,
      selectedId: row?.selected_id ?? null,
      stopTargetId: row?.stop_target_id ?? null,
      ...(row?.action_device_key && row.action_authorization_id
        ? {
            actionSource: {
              deviceKey: row.action_device_key,
              authorizationId: row.action_authorization_id,
            },
          }
        : {}),
    }
  }

  setState(
    threadId: string,
    paused: boolean,
    selectedId: string | null = null,
    stopTargetId: string | null = null,
    actionSource?: QueueDeviceSource,
  ) {
    this.db
      .prepare(
        `INSERT INTO message_queue_state (
          thread_id, paused, selected_id, stop_target_id, action_device_key, action_authorization_id
        ) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET
          paused = excluded.paused, selected_id = excluded.selected_id, stop_target_id = excluded.stop_target_id,
          action_device_key = excluded.action_device_key, action_authorization_id = excluded.action_authorization_id`,
      )
      .run(
        threadId,
        Number(paused),
        selectedId,
        stopTargetId,
        actionSource?.deviceKey ?? null,
        actionSource?.authorizationId ?? null,
      )
  }

  pauseOnRestart(): void {
    this.db.exec(`INSERT INTO message_queue_state (thread_id, paused)
      SELECT DISTINCT thread_id, 1 FROM queued_messages WHERE 1
      ON CONFLICT(thread_id) DO UPDATE SET paused = 1, selected_id = NULL, stop_target_id = NULL,
        action_device_key = NULL, action_authorization_id = NULL`)
  }
}
