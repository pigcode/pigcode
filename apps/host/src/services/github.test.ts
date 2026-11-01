/** 验证 GitHub PR 服务：gh 参数、JSON 解析与错误映射；测试不联网。 */
import { describe, expect, it } from "vitest"
import { GhNotAvailableError, GithubService, PR_JSON_FIELDS, type GhRunner } from "./github"

/** 一次 fake gh 调用的记录。 */
interface GhCall {
  args: string[]
  cwd: string
}

/** 测试用的 PR 响应。 */
const PULL_REQUEST = {
  number: 42,
  url: "https://github.com/pigcode/pigcode/pull/42",
  state: "OPEN",
  title: "Add pull request panel",
  headRefName: "feat/pr",
  baseRefName: "main",
}

/** 构造带 Node 错误字段的 Error，模拟 execFile 失败。 */
function commandError(fields: { stderr?: string; code?: string }): Error {
  return Object.assign(new Error(fields.stderr ?? "gh command failed"), fields)
}

/** 按顺序返回预设结果的 fake runner；Error 会被抛出。 */
function fakeRunner(results: Array<string | Error>): { run: GhRunner; calls: GhCall[] } {
  const calls: GhCall[] = []
  let index = 0
  const run: GhRunner = async (args, cwd) => {
    calls.push({ args, cwd })
    const result = results[index]
    index += 1
    if (result instanceof Error) throw result
    if (result === undefined) throw new Error("unexpected gh call")
    return result
  }
  return { run, calls }
}

/** 用固定 cwd 与分支构造服务，避免测试依赖真实 git 仓库。 */
function makeService(run: GhRunner, branch: string | null = "feat/pr"): GithubService {
  return new GithubService(
    run,
    () => "/repo",
    async () => branch,
  )
}

describe("github service", () => {
  it("creates a pull request with head, title, body and json fields", async () => {
    const { run, calls } = fakeRunner([JSON.stringify(PULL_REQUEST)])
    const service = makeService(run)

    const created = await service.create("thread-1", {
      title: "Add pull request panel",
      body: "Adds a PR tab.",
      base: "main",
    })

    expect(created).toEqual(PULL_REQUEST)
    expect(calls).toEqual([
      {
        args: [
          "pr",
          "create",
          "--head",
          "feat/pr",
          "--title",
          "Add pull request panel",
          "--base",
          "main",
          "--body",
          "Adds a PR tab.",
          "--json",
          PR_JSON_FIELDS,
        ],
        cwd: "/repo",
      },
    ])
  })

  it("defaults an omitted body to an empty string and omits base", async () => {
    const { run, calls } = fakeRunner([JSON.stringify(PULL_REQUEST)])
    const service = makeService(run)

    await service.create("thread-1", { title: "Only a title" })

    const args = calls[0]?.args ?? []
    expect(args).toContain("--body")
    expect(args[args.indexOf("--body") + 1]).toBe("")
    expect(args).not.toContain("--base")
  })

  it("parses the pull request for the current branch", async () => {
    const { run, calls } = fakeRunner([JSON.stringify(PULL_REQUEST)])
    const service = makeService(run)

    const status = await service.status("thread-1")

    expect(status).toEqual(PULL_REQUEST)
    expect(calls).toEqual([
      { args: ["pr", "view", "feat/pr", "--json", PR_JSON_FIELDS], cwd: "/repo" },
    ])
  })

  it("returns null when the branch has no pull request", async () => {
    const { run, calls } = fakeRunner([
      commandError({ stderr: 'no pull requests found for branch "feat/pr"' }),
    ])
    const service = makeService(run)

    await expect(service.status("thread-1")).resolves.toBeNull()
    expect(calls).toHaveLength(1)
  })

  it("returns null for a detached HEAD without invoking gh", async () => {
    const { run, calls } = fakeRunner([])
    const service = makeService(run, null)

    await expect(service.status("thread-1")).resolves.toBeNull()
    expect(calls).toEqual([])
  })

  it("rejects creating from a detached HEAD", async () => {
    const { run, calls } = fakeRunner([])
    const service = makeService(run, null)

    await expect(service.create("thread-1", { title: "Title" })).rejects.toThrow(/detached HEAD/)
    expect(calls).toEqual([])
  })

  it("maps a missing gh binary to GH_NOT_AVAILABLE", async () => {
    const { run } = fakeRunner([commandError({ code: "ENOENT" })])
    const service = makeService(run)

    const failure = service.status("thread-1")
    await expect(failure).rejects.toBeInstanceOf(GhNotAvailableError)
    await expect(failure).rejects.toMatchObject({ code: "GH_NOT_AVAILABLE" })
  })

  it("maps an unauthenticated gh session to a readable error", async () => {
    const { run } = fakeRunner([
      commandError({
        stderr: "To get started with GitHub CLI, please run: gh auth login",
      }),
    ])
    const service = makeService(run)

    await expect(service.status("thread-1")).rejects.toMatchObject({
      code: "GH_NOT_AUTHENTICATED",
      message: expect.stringContaining("gh auth login"),
    })
  })

  it("maps a repository without a GitHub remote to GIT_NO_REMOTE and keeps gh's text", async () => {
    for (const stderr of [
      "no git remotes found",
      "none of the git remotes configured for this repository point to a known GitHub host.",
    ]) {
      const { run } = fakeRunner([commandError({ stderr })])
      const service = makeService(run)

      await expect(service.status("thread-1")).rejects.toMatchObject({
        code: "GIT_NO_REMOTE",
        message: stderr,
      })
    }
  })
})
