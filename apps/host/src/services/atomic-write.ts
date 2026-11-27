/**
 * 原子写文件：先写同目录下的临时文件并 fsync，再改名覆盖目标，最后 fsync 目录（平台支持时）。
 * 进程在任何一步被杀，目标文件要么是旧内容，要么是完整的新内容，不会是空的或半截的。
 * settings.json 与 plugins.yml 都经这里写。
 */
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { mkdir, open, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"

/** 同步版本用到的文件操作；测试可以替换其中一项模拟中途失败。 */
export interface SyncFileOps {
  openSync: typeof openSync
  writeSync: (fd: number, data: string) => number
  fsyncSync: typeof fsyncSync
  closeSync: typeof closeSync
  renameSync: typeof renameSync
}

const defaultSyncOps: SyncFileOps = {
  openSync,
  writeSync: (fd, data) => writeSync(fd, data),
  fsyncSync,
  closeSync,
  renameSync,
}

/** 异步版本用到的文件操作；测试可以替换其中一项模拟中途失败。 */
export interface AsyncFileOps {
  rename: typeof rename
}

const defaultAsyncOps: AsyncFileOps = { rename }

/** 临时文件名：同目录，带进程号与随机串，两次写入不会撞名。 */
function tempPathFor(path: string): string {
  return `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
}

/**
 * fsync 目录，让改名本身落盘。Windows 不能以读方式打开目录，部分文件系统不支持对目录 fsync，
 * 这些情况下跳过：文件内容已经 fsync，改名在下一次元数据刷盘时生效。
 */
function fsyncDirSync(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, "r")
    fsyncSync(fd)
  } catch {
    // 见上。
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // 同 fsyncDirSync。
  }
}

/** 同步原子写；失败时删掉临时文件、保留原文件并抛出。 */
export function writeFileAtomicSync(
  path: string,
  data: string,
  ops: SyncFileOps = defaultSyncOps,
): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const temp = tempPathFor(path)
  try {
    const fd = ops.openSync(temp, "w")
    try {
      ops.writeSync(fd, data)
      ops.fsyncSync(fd)
    } finally {
      ops.closeSync(fd)
    }
    ops.renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  fsyncDirSync(dir)
}

/** 异步原子写；失败时删掉临时文件、保留原文件并抛出。 */
export async function writeFileAtomic(
  path: string,
  data: string,
  ops: AsyncFileOps = defaultAsyncOps,
): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const temp = tempPathFor(path)
  try {
    const handle = await open(temp, "w")
    try {
      await handle.writeFile(data, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await ops.rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  await fsyncDir(dir)
}

function writeFullBuffer(fd: number, payload: Uint8Array): void {
  let offset = 0
  while (offset < payload.byteLength) {
    offset += writeSync(fd, payload, offset, payload.byteLength - offset)
  }
}

/**
 * 创建并独占落盘私有文件（`0o600`）：在同目录以 `"wx"`、`0o600` 写入临时文件、收紧权限并 `fsync`，
 * 再通过 `linkSync` 原子抢占目标路径。返回 `true` 表示当前调用创建成功，`false` 表示目标已存在（`EEXIST`）。
 */
export function writePrivateFileExclusive(
  targetPath: string,
  content: string | Uint8Array,
): boolean {
  const payload = typeof content === "string" ? Buffer.from(content, "utf8") : content
  const tmpPath = tempPathFor(targetPath)
  try {
    const fd = openSync(tmpPath, "wx", 0o600)
    try {
      writeFullBuffer(fd, payload)
      if (process.platform !== "win32") {
        fchmodSync(fd, 0o600)
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    try {
      linkSync(tmpPath, targetPath)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    }
  } finally {
    try {
      unlinkSync(tmpPath)
    } catch {
      // 临时文件可能已删或不再存在。
    }
  }
}

/** 同步原子写二进制文件；用于图片附件与缩略图缓存落盘。 */
export function writeBufferAtomicSync(path: string, data: Uint8Array): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const temp = tempPathFor(path)
  try {
    const fd = openSync(temp, "w")
    try {
      writeFullBuffer(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  fsyncDirSync(dir)
}

/** 异步原子写二进制文件。 */
export async function writeBufferAtomic(path: string, data: Uint8Array): Promise<void> {
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const temp = tempPathFor(path)
  try {
    const handle = await open(temp, "w")
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  await fsyncDir(dir)
}
