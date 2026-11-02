/** 验证原子写：成功时整份替换；中途失败时原文件原样保留，也不留下临时文件。 */
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { writeFileAtomic, writeFileAtomicSync, type SyncFileOps } from "./atomic-write"

async function existing(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-atomic-"))
  const path = join(dir, "plugins.yml")
  await writeFile(path, "old content\n")
  return { dir, path }
}

const realSyncOps: SyncFileOps = {
  openSync,
  writeSync: (fd, data) => writeSync(fd, data),
  fsyncSync,
  closeSync,
  renameSync,
}

describe("atomic writes", () => {
  it("replaces the whole file and leaves no temp file", async () => {
    const { dir, path } = await existing()
    writeFileAtomicSync(path, "sync\n")
    expect(await readFile(path, "utf8")).toBe("sync\n")
    await writeFileAtomic(path, "async\n")
    expect(await readFile(path, "utf8")).toBe("async\n")
    expect(await readdir(dir)).toEqual(["plugins.yml"])
  })

  it("keeps the old file when the rename fails", async () => {
    const { dir, path } = await existing()
    const failingRename = () => {
      throw Object.assign(new Error("EIO: rename failed"), { code: "EIO" })
    }
    expect(() =>
      writeFileAtomicSync(path, "new", { ...realSyncOps, renameSync: failingRename }),
    ).toThrow("rename failed")
    await expect(
      writeFileAtomic(path, "new", {
        rename: async () => {
          throw new Error("EIO: rename failed")
        },
      }),
    ).rejects.toThrow("rename failed")
    expect(await readFile(path, "utf8")).toBe("old content\n")
    expect(await readdir(dir)).toEqual(["plugins.yml"])
  })

  it("keeps the old file when the write stops halfway", async () => {
    const { dir, path } = await existing()
    // 写了一半磁盘就满了：临时文件里是半截内容，原文件不受影响。
    const halfWrite = (fd: number, data: string) => {
      writeSync(fd, data.slice(0, 3))
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
    }
    expect(() =>
      writeFileAtomicSync(path, "new content", { ...realSyncOps, writeSync: halfWrite }),
    ).toThrow("ENOSPC")
    expect(await readFile(path, "utf8")).toBe("old content\n")
    expect(await readdir(dir)).toEqual(["plugins.yml"])
  })
})
