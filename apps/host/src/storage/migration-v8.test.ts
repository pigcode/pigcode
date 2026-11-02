/**
 * 验证 migration 8：持久事件 payload 里的旧字段名（run.started 的 providerId / providerSessionId、
 * thread.updated 的 providerId）改成 agentId / agentSessionId，其他字段和其他事件不变，重复执行无害；
 * 从 v7 升级的数据库迁移前同样留一份备份。
 */
import Database from "better-sqlite3"
import { mkdtemp, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openDatabase } from "./database"
import { SCHEMA_VERSION, migrate } from "./migrations"

const NOW = "2026-11-02T00:00:00.000Z"

/** 一条事件：类型与 payload。 */
type Seed = [type: string, payload: string]

/** 旧版本写下的事件；最后两条不需要改，用来确认迁移不碰它们。 */
const OLD_EVENTS: Seed[] = [
  ["run.started", '{"providerId":"codex","providerSessionId":"ps_1"}'],
  ["thread.updated", '{"providerId":"claude","modelId":"opus","handoff":"summary"}'],
  ["thread.updated", '{"providerId":"codex","modelId":null,"forkFromNativeSessionId":"native-1"}'],
  // 已经是新字段名的事件（新旧字段都在时以新字段为准）。
  ["thread.updated", '{"agentId":"echo","providerId":"stale"}'],
  ["thread.updated", '{"title":"Renamed"}'],
  // 别的事件类型里同名的字段不属于这次改名。
  ["message.completed", '{"role":"user","text":"hi","providerId":"keep"}'],
]

/** 用 v7 的迁移造一个旧数据库，写入一个线程和上面的事件。 */
function seedV7(db: Database.Database, events: readonly Seed[] = OLD_EVENTS): void {
  migrate(db, 7)
  db.exec(`
    INSERT INTO projects (id, root_path, name, created_at) VALUES ('pr_1', '/tmp/p', 'p', '${NOW}');
    INSERT INTO threads (id, project_id, title, default_agent_id, permission_mode, created_at,
      updated_at) VALUES ('th_1', 'pr_1', 'T', 'claude', 'workspace-write', '${NOW}', '${NOW}');
  `)
  const insert = db.prepare(
    `INSERT INTO thread_events (thread_id, run_id, type, payload_json, schema_version, created_at)
     VALUES ('th_1', NULL, ?, ?, 1, '${NOW}')`,
  )
  for (const [type, payload] of events) insert.run(type, payload)
}

/** 按 seq 顺序读出 payload。 */
function payloads(db: Database.Database): unknown[] {
  return db
    .prepare(`SELECT payload_json FROM thread_events ORDER BY seq`)
    .pluck()
    .all()
    .map((json) => JSON.parse(json as string) as unknown)
}

describe("migration v8", () => {
  it("renames the provider fields of run.started and thread.updated payloads", () => {
    const db = new Database(":memory:")
    seedV7(db)
    migrate(db)
    expect(SCHEMA_VERSION).toBe(8)
    expect(db.pragma("user_version", { simple: true })).toBe(8)
    expect(payloads(db)).toEqual([
      { agentId: "codex", agentSessionId: "ps_1" },
      { agentId: "claude", modelId: "opus", handoff: "summary" },
      { agentId: "codex", modelId: null, forkFromNativeSessionId: "native-1" },
      { agentId: "echo" },
      { title: "Renamed" },
      { role: "user", text: "hi", providerId: "keep" },
    ])
    const leftover = db
      .prepare(
        `SELECT COUNT(*) FROM thread_events
         WHERE type IN ('run.started', 'thread.updated') AND payload_json LIKE '%provider%'`,
      )
      .pluck()
      .get()
    expect(leftover).toBe(0)
    db.close()
  })

  it("is harmless to run again", () => {
    const db = new Database(":memory:")
    seedV7(db)
    migrate(db)
    const before = db.prepare(`SELECT seq, payload_json FROM thread_events ORDER BY seq`).all()
    db.pragma("user_version = 7")
    expect(() => migrate(db)).not.toThrow()
    expect(db.prepare(`SELECT seq, payload_json FROM thread_events ORDER BY seq`).all()).toEqual(
      before,
    )
    db.close()
  })

  it("leaves a payload that is not valid JSON untouched", () => {
    const db = new Database(":memory:")
    seedV7(db, [["run.started", "not json"]])
    expect(() => migrate(db)).not.toThrow()
    expect(db.prepare(`SELECT payload_json FROM thread_events`).pluck().get()).toBe("not json")
    db.close()
  })

  it("backs up a v7 database before migrating it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-v8-"))
    const path = join(dir, "pigcode.db")
    const old = new Database(path)
    seedV7(old)
    old.close()

    openDatabase(path).close()
    expect((await readdir(dir)).filter((name) => name.endsWith(".bak"))).toEqual([
      "pigcode.db.schema-v7.bak",
    ])
    const backup = new Database(join(dir, "pigcode.db.schema-v7.bak"), { readonly: true })
    expect(backup.pragma("user_version", { simple: true })).toBe(7)
    expect(
      backup
        .prepare(`SELECT payload_json FROM thread_events WHERE type = 'run.started'`)
        .pluck()
        .get(),
    ).toBe('{"providerId":"codex","providerSessionId":"ps_1"}')
    backup.close()
  })
})
