/** 管理 attachments 表的 SQLite CRUD。 */
import type { ImageAttachmentMimeType, ImageAttachmentRef } from "@pigcode/contracts"
import type { PigcodeDatabase } from "./database"

export type AttachmentStatus = "staging" | "committed"

export interface AttachmentRecord {
  id: string
  threadId: string | null
  ownerDeviceKey: string | null
  sha256: string
  mimeType: ImageAttachmentMimeType
  fileName: string
  storageName: string
  sizeBytes: number
  width: number | null
  height: number | null
  status: AttachmentStatus
  createdAt: string
  expiresAt: string | null
}

interface AttachmentRow {
  id: string
  thread_id: string | null
  owner_device_key: string | null
  sha256: string
  mime_type: string
  file_name: string
  storage_name: string
  size_bytes: number
  width: number | null
  height: number | null
  status: string
  created_at: string
  expires_at: string | null
}

export function toAttachmentRef(record: AttachmentRecord): ImageAttachmentRef {
  return {
    id: record.id,
    mimeType: record.mimeType,
    fileName: record.fileName,
    sizeBytes: record.sizeBytes,
    ...(record.width !== null ? { width: record.width } : {}),
    ...(record.height !== null ? { height: record.height } : {}),
  }
}

function mapRow(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    ownerDeviceKey: row.owner_device_key,
    sha256: row.sha256,
    mimeType: row.mime_type as ImageAttachmentMimeType,
    fileName: row.file_name,
    storageName: row.storage_name,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    status: row.status as AttachmentStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

export class AttachmentStore {
  constructor(private readonly db: PigcodeDatabase) {}

  insert(record: AttachmentRecord): void {
    this.db
      .prepare(
        `INSERT INTO attachments (
           id, thread_id, owner_device_key, sha256, mime_type, file_name,
           storage_name, size_bytes, width, height, status, created_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.threadId,
        record.ownerDeviceKey,
        record.sha256,
        record.mimeType,
        record.fileName,
        record.storageName,
        record.sizeBytes,
        record.width,
        record.height,
        record.status,
        record.createdAt,
        record.expiresAt,
      )
  }

  get(id: string): AttachmentRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM attachments WHERE id = ?`).get(id) as
      | AttachmentRow
      | undefined
    return row ? mapRow(row) : undefined
  }

  getMany(ids: readonly string[]): AttachmentRecord[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => "?").join(", ")
    const rows = this.db
      .prepare(`SELECT * FROM attachments WHERE id IN (${placeholders})`)
      .all(...ids) as AttachmentRow[]
    return rows.map(mapRow)
  }

  listByThread(threadId: string): AttachmentRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM attachments WHERE thread_id = ? ORDER BY created_at ASC`)
      .all(threadId) as AttachmentRow[]
    return rows.map(mapRow)
  }

  commitStaging(ids: readonly string[], threadId: string): void {
    if (ids.length === 0) return
    const update = this.db.prepare(
      `UPDATE attachments SET status = 'committed', thread_id = ?, expires_at = NULL
       WHERE id = ? AND status = 'staging'`,
    )
    this.db.transaction(() => {
      for (const id of ids) update.run(threadId, id)
    })()
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM attachments WHERE id = ?`).run(id).changes === 1
  }

  deleteByThread(threadId: string): number {
    return this.db.prepare(`DELETE FROM attachments WHERE thread_id = ?`).run(threadId).changes
  }

  listExpiredStaging(nowIso: string): AttachmentRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM attachments
         WHERE status = 'staging' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .all(nowIso) as AttachmentRow[]
    return rows.map(mapRow)
  }

  deleteExpiredStaging(nowIso: string): number {
    return this.db
      .prepare(
        `DELETE FROM attachments
         WHERE status = 'staging' AND expires_at IS NOT NULL AND expires_at <= ?`,
      )
      .run(nowIso).changes
  }
}
