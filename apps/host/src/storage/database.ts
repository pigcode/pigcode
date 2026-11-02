/** 打开 SQLite 数据库并执行迁移；测试使用 :memory:。 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import Database from "better-sqlite3"
import { SCHEMA_VERSION, migrate, schemaVersion } from "./migrations"

/** Host 使用的 SQLite 数据库句柄类型。 */
export type PigcodeDatabase = Database.Database

/**
 * 迁移前备份的文件名：数据库文件旁边的 `<文件名>.schema-v<旧版本>.bak`。
 * 同名文件已经存在时加上时间戳，不覆盖以前的备份。
 */
export function backupPathFor(path: string, version: number, now: Date = new Date()): string {
  const plain = `${path}.schema-v${version}.bak`
  if (!existsSync(plain)) return plain
  const stamp = now.toISOString().replace(/[:.]/g, "-")
  for (let index = 0; ; index += 1) {
    const candidate = `${path}.schema-v${version}.${stamp}${index > 0 ? `-${index}` : ""}.bak`
    if (!existsSync(candidate)) return candidate
  }
}

/** 把刚写完的备份刷到磁盘；VACUUM INTO 自己不保证 fsync 输出文件。 */
function fsyncFile(path: string): void {
  const fd = openSync(path, "r+")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * 已有的数据库要迁移时先备份，返回备份文件；不需要迁移时返回 null。
 * 用 `VACUUM INTO` 经当前连接写出一份完整的库：WAL 里已提交的内容都在里面，不依赖 -wal 文件。
 * 先写 `<备份>.tmp`，fsync 后才改成正式的名字；失败时删掉临时文件，失败的尝试不会占用
 * `pigcode.db.schema-v<旧版本>.bak` 这个名字，也不会留下一份看起来完整、其实只写了一半的备份。
 *
 * 备份只用于手工恢复（步骤见 services/legacy-names.ts 开头）：不支持降级，旧版本的 Pigcode 打不开迁移后的
 * 数据库。备份不会自动清理，每次跨版本迁移留一份，由用户自己删除。
 */
function backupBeforeMigrating(db: PigcodeDatabase, path: string): string | null {
  const version = schemaVersion(db)
  if (version === 0 || version >= SCHEMA_VERSION) return null
  const target = backupPathFor(path, version)
  const temp = `${target}.tmp`
  try {
    // 上一次在这一步崩溃留下的临时文件：名字是这里独有的，直接删掉重来。
    rmSync(temp, { force: true })
    db.prepare(`VACUUM INTO ?`).run(temp)
    fsyncFile(temp)
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`could not back up the database before migrating it (${path}): ${reason}`, {
      cause: error,
    })
  }
  return target
}

/**
 * 打开数据库、启用 WAL 与外键，并把 schema 迁移到最新版本；文件所在目录不存在时先创建。
 * 已有的数据库在迁移前备份一份，见 backupBeforeMigrating。数据库比这个版本的 Pigcode 新（用户装回了旧版本）
 * 时直接报错，不改文件：不支持降级。任何一步失败都会关掉连接再抛出，Host 启动时据此报告原因。
 */
export function openDatabase(path: string): PigcodeDatabase {
  const onDisk = path !== ":memory:"
  if (onDisk) mkdirSync(dirname(path), { recursive: true })
  const existed = onDisk && existsSync(path)
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
    if (existed) backupBeforeMigrating(db, path)
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return db
}
