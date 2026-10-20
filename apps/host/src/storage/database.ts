/** 打开 SQLite 数据库并执行迁移；测试使用 :memory:。 */
import Database from "better-sqlite3"
import { migrate } from "./migrations"

/** Host 使用的 SQLite 数据库句柄类型。 */
export type PigcodeDatabase = Database.Database

/** 打开数据库、启用 WAL 与外键，并把 schema 迁移到最新版本。 */
export function openDatabase(path: string): PigcodeDatabase {
  const db = new Database(path)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  migrate(db)
  return db
}
