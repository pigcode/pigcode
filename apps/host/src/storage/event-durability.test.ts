/**
 * Host 崩溃不丢已提交事件（#6 缺口 C）。
 *
 * 上面 event-store 的用例都在同一个进程里：即使没提交到磁盘，内存里的连接也能读回来，所以
 * 「崩溃」这件事根本没被验证过。这里让一个真实子进程写事件，写完通知父进程，然后用 SIGKILL
 * 直接杀掉（不给它关连接、跑 pragma 的机会），再由父进程从同一个文件库读回来。
 *
 * 子进程用 better-sqlite3 直接写，不 import Host 的 TS 源码：node 的类型剥离既不支持参数属性，
 * 也没有仓库需要的无扩展名 import 解析。SQLite 层的保证和上层封装无关。
 *
 * 数据库是 WAL 模式，已经提交的事务在 -wal 文件里；重新打开时 SQLite 会自动恢复它。
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { openDatabase } from "./database"
import { EventStore } from "./event-store"

/** 仓库里的 apps/host，子进程用同样的 cwd 解析 node_modules。 */
const hostDir = fileURLToPath(new URL("../..", import.meta.url))

/** 子进程：按 EventStore 的写法插一条，打印 seq，然后一直等着被杀。 */
const WRITER = `
const Database = require("better-sqlite3")
const db = new Database(process.env.PIGCODE_TEST_DB)
db.pragma("journal_mode = WAL")
db.pragma("foreign_keys = ON")
const result = db
  .prepare(
    \`INSERT INTO thread_events (thread_id, run_id, type, payload_json, schema_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?)\`,
  )
  .run(
    "th_crash",
    "run_crash",
    "message.completed",
    JSON.stringify({ role: "assistant", text: "已经提交的消息" }),
    1,
    new Date().toISOString(),
  )
process.stdout.write(String(result.lastInsertRowid) + "\\n")
// 不关连接：让 -wal 留在磁盘上，和崩溃后的现场一样。
setInterval(() => {}, 1000)
`

/** 等子进程打出第一行；超时说明它根本没写成功。 */
function waitForLine(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("writer did not report a seq")), 20_000)
    child.stdout?.once("data", (chunk: Buffer) => {
      clearTimeout(timer)
      resolve(chunk.toString().split("\n")[0] ?? "")
    })
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
  })
}

/** 杀掉子进程并等它真的退出，避免和后面的读抢文件。 */
function killHard(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    child.once("exit", () => resolve())
    // SIGKILL 不做任何清理：连接不关、pragma 不跑，模拟真正的崩溃。
    child.kill("SIGKILL")
  })
}

describe("committed events survive a Host crash", { timeout: 60_000 }, () => {
  it("reads back an event written by a process that was then killed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pigcode-crash-"))
    const path = join(dir, "pigcode.db")
    // 父进程先建好 schema：迁移是 Host 启动时做的事，崩溃发生在运行期间。
    openDatabase(path).close()

    const child = spawn(process.execPath, ["-e", WRITER], {
      cwd: hostDir,
      env: { ...process.env, PIGCODE_TEST_DB: path },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    try {
      const seq = Number(await waitForLine(child))
      expect(stderr).toBe("")
      expect(seq).toBeGreaterThan(0)

      await killHard(child)
      // -wal 还在：崩溃时 SQLite 来不及做 checkpoint。
      expect(child.signalCode).toBe("SIGKILL")

      // 新连接从同一个文件读：已经提交的事务必须还在，内容不变。
      const db = openDatabase(path)
      try {
        const events = new EventStore(db).read("th_crash", 0)
        expect(events).toHaveLength(1)
        expect(events[0]).toMatchObject({
          seq,
          threadId: "th_crash",
          runId: "run_crash",
          type: "message.completed",
          payload: { role: "assistant", text: "已经提交的消息" },
        })
      } finally {
        db.close()
      }
    } finally {
      await killHard(child)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
