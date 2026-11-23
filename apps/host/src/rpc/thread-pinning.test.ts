import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import Database from "better-sqlite3"
import { expect, it, vi } from "vitest"
import { migrate } from "../storage/migrations"
import { startMobileHost } from "./mobile-test-fixture"

it("upgrades existing threads, saves pin changes, and clears a pin when archiving", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pigcode-thread-pin-"))
  const storagePath = join(directory, "host.sqlite")
  const old = new Database(storagePath)
  const updatedAt = "2026-11-20T00:00:00.000Z"
  migrate(old, 9)
  old.prepare("INSERT INTO projects(id, root_path, name, created_at) VALUES (?, ?, ?, ?)")
    .run("project", directory, "置顶验收", updatedAt)
  old.prepare(`
    INSERT INTO threads(id, project_id, title, default_agent_id, permission_mode, created_at, updated_at)
    VALUES ('thread', 'project', '旧版本的会话', 'fake', 'workspace-write', ?, ?)
  `).run(updatedAt, updatedAt)
  old.close()

  try {
    const onDesktopMessage = vi.fn()
    const host = await startMobileHost({ storagePath, onDesktopMessage })
    const target = { id: "thread", updatedAt }
    const params = { threadId: target.id }
    try {
      expect(await host.call("thread.list")).toMatchObject({ result: [{ ...target, pinned: false }] })
      expect(await host.call("thread.setPinned", { ...params, pinned: true })).toMatchObject({
        result: { ...target, pinned: true },
      })
      expect(onDesktopMessage).toHaveBeenCalledWith(expect.objectContaining({
        method: "thread.changed",
        params: expect.objectContaining({ ...target, pinned: true }),
      }))
    } finally {
      await host.stop()
    }

    const reopened = await startMobileHost({ storagePath })
    try {
      expect(await reopened.call("thread.list")).toMatchObject({ result: [{ ...target, pinned: true }] })
      expect(await reopened.call("thread.archive", params)).toMatchObject({
        result: { id: target.id, pinned: false, archivedAt: expect.any(String) },
      })
      expect(await reopened.call("thread.setPinned", { ...params, pinned: true })).toHaveProperty("error")
      expect(await reopened.call("thread.unarchive", params)).toMatchObject({
        result: { id: target.id, pinned: false, archivedAt: null },
      })
    } finally {
      await reopened.stop()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
