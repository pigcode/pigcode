/** 验证工作台文件写操作与桌面端 PR 写命令通过 RPC 可达及安全校验。 */
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { GithubService, type GhRunner } from "../services/github"
import { call, createWorkbenchHarness } from "./workbench-test-harness"

const harness = createWorkbenchHarness()

afterEach(async () => {
  await harness.cleanup()
})

describe("workbench rpc writes", { timeout: 30_000 }, () => {
  it("dispatches workspace.createFile, renamePath, and deletePath with safety checks", async () => {
    const { root, thread, transport } = await harness.setup()
    const outside = await mkdtemp(join(tmpdir(), "pigcode-rpc-outside-"))
    harness.roots.push(outside)
    const outsideFile = join(outside, "keep.txt")
    await writeFile(outsideFile, "do not delete")

    const created = await call(transport, "1", "workspace.createFile", {
      threadId: thread.id,
      path: "src/hello.ts",
      text: "export const hi = 1\n",
    })
    expect(created.error).toBeUndefined()
    expect(created.result).toMatchObject({ path: "src/hello.ts", size: 20 })
    expect(await readFile(join(root, "src/hello.ts"), "utf8")).toBe("export const hi = 1\n")

    // Creating existing file fails
    const dup = await call(transport, "2", "workspace.createFile", {
      threadId: thread.id,
      path: "src/hello.ts",
      text: "overwrite",
    })
    expect(dup.error?.message).toContain("PATH_EXISTS")

    // Rename across directories
    const renamed = await call(transport, "3", "workspace.renamePath", {
      threadId: thread.id,
      oldPath: "src/hello.ts",
      newPath: "lib/greet.ts",
    })
    expect(renamed.result).toEqual({ oldPath: "src/hello.ts", newPath: "lib/greet.ts" })
    expect(await readFile(join(root, "lib/greet.ts"), "utf8")).toBe("export const hi = 1\n")

    // Non-empty directory delete requires recursive: true
    const blockedDir = await call(transport, "4", "workspace.deletePath", {
      threadId: thread.id,
      path: "lib",
    })
    expect(blockedDir.error?.message).toContain("DIR_NOT_EMPTY")

    const deletedDir = await call(transport, "5", "workspace.deletePath", {
      threadId: thread.id,
      path: "lib",
      recursive: true,
    })
    expect(deletedDir.result).toEqual({ path: "lib", deleted: true })

    // Deleting a symlink pointing outside deletes only the symlink itself
    await symlink(outsideFile, join(root, "ext-link.txt"))
    const deletedLink = await call(transport, "6", "workspace.deletePath", {
      threadId: thread.id,
      path: "ext-link.txt",
    })
    expect(deletedLink.result).toEqual({ path: "ext-link.txt", deleted: true })
    expect(await readFile(outsideFile, "utf8")).toBe("do not delete")

    // Refuses .git writes and path escapes
    expect(
      (
        await call(transport, "7", "workspace.createFile", {
          threadId: thread.id,
          path: ".git/evil",
        })
      ).error?.message,
    ).toContain("git metadata")
    expect(
      (
        await call(transport, "8", "workspace.deletePath", {
          threadId: thread.id,
          path: ".",
        })
      ).error?.message,
    ).toContain("workspace root")
  })

  it("dispatches desktop PR write commands (create draft, comment, ready, close, reopen, merge)", async () => {
    const { ctx, thread, transport } = await harness.setup()
    const calls: string[][] = []
    let state: "OPEN" | "CLOSED" | "MERGED" = "OPEN"
    let isDraft = true
    const makePr = () =>
      JSON.stringify({
        number: 77,
        url: "https://github.com/pigcode/pigcode/pull/77",
        state,
        title: "Desktop PR",
        headRefName: "feat/rpc",
        baseRefName: "main",
        isDraft,
      })

    const runner: GhRunner = async (args) => {
      calls.push(args)
      if (args[1] === "create") return makePr()
      if (args[1] === "comment") return ""
      if (args[1] === "ready") {
        isDraft = false
        return ""
      }
      if (args[1] === "close") {
        state = "CLOSED"
        return ""
      }
      if (args[1] === "reopen") {
        state = "OPEN"
        return ""
      }
      if (args[1] === "merge") {
        state = "MERGED"
        return ""
      }
      if (args[1] === "view") return makePr()
      throw new Error(`unexpected gh args: ${args.join(" ")}`)
    }
    ctx.provide(
      "github",
      new GithubService(
        runner,
        () => ctx.workspace.root(thread.id),
        async () => "feat/rpc",
      ),
    )

    const created = await call(transport, "1", "pr.create", {
      threadId: thread.id,
      title: "Desktop PR",
      body: "Body",
      draft: true,
    })
    expect(created.result).toMatchObject({ number: 77, isDraft: true })
    expect(calls[0]).toContain("--draft")

    const commented = await call(transport, "2", "pr.comment", {
      threadId: thread.id,
      body: "Nice work",
    })
    expect(commented.result).toEqual({ ok: true })

    const readied = await call(transport, "3", "pr.ready", { threadId: thread.id })
    expect(readied.result).toMatchObject({ number: 77, isDraft: false })

    const closed = await call(transport, "4", "pr.close", { threadId: thread.id })
    expect(closed.result).toMatchObject({ number: 77, state: "CLOSED" })

    const reopened = await call(transport, "5", "pr.reopen", { threadId: thread.id })
    expect(reopened.result).toMatchObject({ number: 77, state: "OPEN" })

    const merged = await call(transport, "6", "pr.merge", {
      threadId: thread.id,
      method: "rebase",
      deleteBranch: true,
    })
    expect(merged.result).toMatchObject({ number: 77, state: "MERGED" })
  })
})
