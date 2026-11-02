/**
 * 打开数据库时的安全检查：比应用新的数据库原样拒绝；备份失败时不占用正式的备份名、不迁移；
 * v7 改名遇到新旧名字并存且旧的有数据时报错，不悄悄丢数据。
 */
import Database from "better-sqlite3"
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises"
import { writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { openDatabase } from "./database"
import { SCHEMA_VERSION, migrate } from "./migrations"

const NOW = "2026-10-30T00:00:00.000Z"

async function v6File(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-db-safety-"))
  const path = join(dir, "pigcode.db")
  const db = new Database(path)
  db.pragma("journal_mode = WAL")
  migrate(db, 6)
  db.exec(`
    INSERT INTO projects (id, root_path, name, created_at) VALUES ('pr_1', '/tmp/p', 'p', '${NOW}');
    INSERT INTO threads (id, project_id, title, default_provider_id, permission_mode, created_at,
      updated_at) VALUES ('th_1', 'pr_1', 'T', 'claude', 'workspace-write', '${NOW}', '${NOW}');
  `)
  db.close()
  return { dir, path }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("a database newer than the app", () => {
  it("is rejected and left untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-db-safety-"))
    const path = join(dir, "pigcode.db")
    const db = new Database(path)
    db.exec(`CREATE TABLE future (id TEXT)`)
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`)
    db.close()
    const before = await readFile(path)
    const mtime = (await stat(path)).mtimeMs

    expect(() => openDatabase(path)).toThrow(
      `database schema v${SCHEMA_VERSION + 1} is newer than this app (v${SCHEMA_VERSION})`,
    )
    expect(await readFile(path)).toEqual(before)
    expect((await stat(path)).mtimeMs).toBe(mtime)
    expect((await readdir(dir)).filter((name) => name.includes(".bak"))).toEqual([])
    // 文件还能照常打开，版本没被改动。
    const check = new Database(path, { readonly: true })
    expect(check.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION + 1)
    expect(check.pragma("journal_mode", { simple: true })).toBe("delete")
    check.close()
  })
})

describe("a failed backup", () => {
  it("leaves no backup under the plain name, does not migrate and reports the cause", async () => {
    const { dir, path } = await v6File()
    const prepare = Database.prototype.prepare
    // 模拟磁盘写满：VACUUM INTO 写了半个文件就失败。
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      source: string,
    ) {
      if (!source.startsWith("VACUUM INTO")) return prepare.call(this, source)
      return {
        run: (target: string) => {
          writeFileSync(target, "half a database")
          throw new Error("database or disk is full")
        },
      } as unknown as Database.Statement
    })
    expect(() => openDatabase(path)).toThrow(
      /could not back up the database before migrating it .*: database or disk is full/,
    )
    vi.restoreAllMocks()

    expect((await readdir(dir)).filter((name) => name.includes(".bak"))).toEqual([])
    const old = new Database(path, { readonly: true })
    expect(old.pragma("user_version", { simple: true })).toBe(6)
    expect(old.prepare(`SELECT default_provider_id FROM threads`).pluck().get()).toBe("claude")
    old.close()

    // 下一次启动正常时，备份拿到的是正式的名字。
    openDatabase(path).close()
    expect((await readdir(dir)).filter((name) => name.includes(".bak"))).toEqual([
      "pigcode.db.schema-v6.bak",
    ])
  })
})

describe("v7 rename safety", () => {
  it("refuses to drop a provider_sessions table that has rows next to agent_sessions", () => {
    const db = new Database(":memory:")
    migrate(db, 6)
    db.exec(`
      INSERT INTO projects (id, root_path, name, created_at) VALUES ('pr_1', '/p', 'p', '${NOW}');
      INSERT INTO threads (id, project_id, title, default_provider_id, permission_mode, created_at,
        updated_at) VALUES ('th_1', 'pr_1', 'T', 'claude', 'workspace-write', '${NOW}', '${NOW}');
      INSERT INTO provider_sessions (id, thread_id, provider_id, cwd, status, created_at)
        VALUES ('ps_1', 'th_1', 'claude', '/p', 'active', '${NOW}');
      CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, agent_id TEXT);
    `)
    expect(() => migrate(db)).toThrow(
      "cannot rename table provider_sessions to agent_sessions: both exist and provider_sessions has rows",
    )
    // 迁移在事务里：版本号和数据都没动。
    expect(db.pragma("user_version", { simple: true })).toBe(6)
    expect(db.prepare(`SELECT COUNT(*) FROM provider_sessions`).pluck().get()).toBe(1)
    db.close()
  })

  it("refuses to drop an old column that has values next to the new one", () => {
    const db = new Database(":memory:")
    migrate(db, 6)
    db.exec(`
      ALTER TABLE threads ADD COLUMN default_agent_id TEXT;
      INSERT INTO projects (id, root_path, name, created_at) VALUES ('pr_1', '/p', 'p', '${NOW}');
      INSERT INTO threads (id, project_id, title, default_provider_id, permission_mode, created_at,
        updated_at) VALUES ('th_1', 'pr_1', 'T', 'claude', 'workspace-write', '${NOW}', '${NOW}');
    `)
    expect(() => migrate(db)).toThrow(
      "cannot rename threads.default_provider_id to default_agent_id: both columns exist",
    )
    expect(db.pragma("user_version", { simple: true })).toBe(6)
    db.close()
  })

  it("skips an empty old table or column next to the new one", () => {
    const db = new Database(":memory:")
    migrate(db, 6)
    db.exec(`CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, agent_id TEXT)`)
    expect(() => migrate(db)).not.toThrow()
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION)
    db.close()
  })
})
