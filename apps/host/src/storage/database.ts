/** 打开 SQLite 数据库并执行迁移；测试使用 :memory:。 */
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"
import { SCHEMA_VERSION, migrate, schemaVersion } from "./migrations"

/** Host 使用的 SQLite 数据库句柄类型。 */
export type PigcodeDatabase = Database.Database

/**
 * 打开数据库、启用 WAL 与外键，并把 schema 迁移到最新版本；文件所在目录不存在时先创建。
 * 数据库比这个版本的 Pigcode 新（用户装回了旧版本）时直接报错，不改文件：不支持降级。
 * 任何一步失败都会关掉连接再抛出，Host 启动时据此报告原因。
 */
export function openDatabase(path: string): PigcodeDatabase {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  try {
    // 先看版本再做任何写操作：更新的数据库原样留着。
    const version = schemaVersion(db)
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `database schema v${version} is newer than this app (v${SCHEMA_VERSION}): ${path}`,
      )
    }
    db.pragma("journal_mode = WAL")
    db.pragma("foreign_keys = ON")
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}
