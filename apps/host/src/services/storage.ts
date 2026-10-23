/** 提供 SQLite、事件日志和回执服务。 */
import type { Context } from "cordis"
import { openDatabase } from "../storage/database"
import { EventStore } from "../storage/event-store"
import { ReceiptStore } from "../storage/receipt-store"

/** Host 共享的存储服务，聚合数据库、事件日志与命令回执。 */
export interface StorageService {
  db: ReturnType<typeof openDatabase>
  events: EventStore
  receipts: ReceiptStore
}

declare module "cordis" {
  interface Context {
    storage: StorageService
  }
}

/** storage 插件的配置；path 缺省时使用内存数据库（测试与 `--dump-config`）。 */
export interface StorageConfig {
  path?: string
}

/** 打开数据库并提供 storage 服务，插件卸载时关闭连接。 */
export function apply(ctx: Context, config: StorageConfig = {}): void {
  const db = openDatabase(config.path ?? ":memory:")
  const storage: StorageService = {
    db,
    events: new EventStore(db),
    receipts: new ReceiptStore(db),
  }
  ctx.provide("storage", storage)
  ctx.effect(() => () => db.close())
}
