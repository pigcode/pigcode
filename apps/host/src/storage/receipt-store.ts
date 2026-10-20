/** 保存命令回执，保证断线重试不会重复执行。 */
import type { PigcodeDatabase } from "./database"

/** 命令回执的持久化读写入口。 */
export class ReceiptStore {
  constructor(private readonly db: PigcodeDatabase) {}

  /** 读取命令回执；不存在时返回 undefined。 */
  get(commandId: string): unknown | undefined {
    const row = this.db
      .prepare(`SELECT result_json FROM command_receipts WHERE command_id = ?`)
      .get(commandId) as { result_json: string } | undefined
    return row ? (JSON.parse(row.result_json) as unknown) : undefined
  }

  /** 写入或覆盖命令回执，使同一 commandId 幂等。 */
  put(commandId: string, result: unknown): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO command_receipts (command_id, result_json, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(commandId, JSON.stringify(result), new Date().toISOString())
  }
}
