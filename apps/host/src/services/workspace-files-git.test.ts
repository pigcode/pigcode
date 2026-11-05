/** git 在读完输入之前就退出时（不是仓库），请求忽略列表不能把 Host 带崩。 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { gitIgnored, listDirectory } from "./workspace-files"

const roots: string[] = []
const path = process.env.PATH

afterEach(async () => {
  process.env.PATH = path
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/** 把 git 换成立刻退出、不读 stdin 的脚本：退出码 128 是「不是仓库」时 git 的退出码。 */
async function withFailingGit(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pigcode-workspace-"))
  roots.push(root)
  await writeFile(join(root, "a.txt"), "one\n")
  const bin = await mkdtemp(join(tmpdir(), "pigcode-fake-git-"))
  roots.push(bin)
  await writeFile(join(bin, "git"), "#!/bin/sh\nexit 128\n")
  await chmod(join(bin, "git"), 0o755)
  process.env.PATH = `${bin}:${path ?? ""}`
  return root
}

describe.skipIf(process.platform === "win32")("asking git about ignored paths", () => {
  it("survives git exiting before it has read a long input", async () => {
    const root = await withFailingGit()
    // 输入足够长，写入要跨好几个 tick；git 那时早已退出，管道已经没人读。
    const paths = Array.from({ length: 50_000 }, (_, index) => `file-${index}.txt`)
    await expect(gitIgnored(root, paths)).resolves.toBeNull()
  })

  it("still lists the directory", async () => {
    const root = await withFailingGit()
    const listing = await listDirectory(root, "")
    expect(listing.entries.map((entry) => entry.name)).toContain("a.txt")
  })
})
