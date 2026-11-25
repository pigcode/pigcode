/** 验证 GitHub PR 服务：gh 参数、JSON 解析与错误映射；测试不联网。 */
import { describe, expect, it } from "vitest"
import { NotAGitRepoError } from "./git"
import {
  GhNotAvailableError,
  GithubService,
  PR_DETAILED_JSON_FIELDS,
  PR_JSON_FIELDS,
  summarizeStatusCheckRollup,
  type GhRunner,
} from "./github"

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

  it("returns detailed PR status with normalized checksSummary from CheckRun and StatusContext entries", async () => {
    const detailedPayload = {
      ...PULL_REQUEST,
      isDraft: true,
      additions: 128,
      deletions: 34,
      changedFiles: 5,
      reviewDecision: "APPROVED",
      updatedAt: "2026-11-25T10:20:30Z",
      statusCheckRollup: [
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
        { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
        { __typename: "StatusContext", state: "SUCCESS" },
        { __typename: "StatusContext", state: "ERROR" },
        { __typename: "StatusContext", state: "PENDING" },
      ],
    }
    const { run, calls } = fakeRunner([JSON.stringify(detailedPayload)])
    const service = makeService(run)

    const result = await service.detailedStatus("thread-1")

    expect(calls).toEqual([
      { args: ["pr", "view", "feat/pr", "--json", PR_DETAILED_JSON_FIELDS], cwd: "/repo" },
    ])
    expect(result).toEqual({
      status: "ok",
      branch: "feat/pr",
      pr: {
        ...PULL_REQUEST,
        isDraft: true,
        additions: 128,
        deletions: 34,
        changedFiles: 5,
        reviewDecision: "APPROVED",
        updatedAt: "2026-11-25T10:20:30Z",
        checksSummary: { total: 7, passed: 3, failed: 2, pending: 2 },
      },
    })
  })

  it("falls back to base PR_JSON_FIELDS when an older gh CLI rejects extended JSON fields", async () => {
    const { run, calls } = fakeRunner([
      commandError({ stderr: 'Unknown JSON field: "statusCheckRollup"' }),
      JSON.stringify(PULL_REQUEST),
    ])
    const service = makeService(run)

    const result = await service.detailedStatus("thread-1")

    expect(calls).toEqual([
      { args: ["pr", "view", "feat/pr", "--json", PR_DETAILED_JSON_FIELDS], cwd: "/repo" },
      { args: ["pr", "view", "feat/pr", "--json", PR_JSON_FIELDS], cwd: "/repo" },
    ])
    expect(result).toEqual({
      status: "ok",
      branch: "feat/pr",
      pr: PULL_REQUEST,
    })
  })

  it("maps detailedStatus non-ok conditions cleanly without throwing", async () => {
    // Non-git repository
    const notGit = new GithubService(
      async () => {
        throw new Error("should not call gh")
      },
      () => "/not-a-repo",
      async () => {
        throw new NotAGitRepoError("/not-a-repo")
      },
    )
    await expect(notGit.detailedStatus("thread-1")).resolves.toEqual({
      status: "not-git",
      branch: null,
    })

    // Detached HEAD inside a git repo
    const detached = makeService(async () => {
      throw new Error("should not call gh")
    }, null)
    await expect(detached.detailedStatus("thread-1")).resolves.toEqual({
      status: "no-pr",
      branch: null,
    })

    // No PR on branch
    const noPr = makeService(
      fakeRunner([commandError({ stderr: 'no pull requests found for branch "feat/pr"' })]).run,
    )
    await expect(noPr.detailedStatus("thread-1")).resolves.toEqual({
      status: "no-pr",
      branch: "feat/pr",
    })

    // gh unavailable
    const noGh = makeService(fakeRunner([commandError({ code: "ENOENT" })]).run)
    await expect(noGh.detailedStatus("thread-1")).resolves.toEqual({
      status: "gh-unavailable",
      branch: "feat/pr",
    })

    // gh unauthenticated
    const unauth = makeService(
      fakeRunner([
        commandError({ stderr: "To get started with GitHub CLI, please run: gh auth login" }),
      ]).run,
    )
    await expect(unauth.detailedStatus("thread-1")).resolves.toEqual({
      status: "gh-unauthenticated",
      branch: "feat/pr",
    })

    // no remote
    const noRemote = makeService(
      fakeRunner([commandError({ stderr: "no git remotes found" })]).run,
    )
    await expect(noRemote.detailedStatus("thread-1")).resolves.toEqual({
      status: "no-remote",
      branch: "feat/pr",
    })

    // Empty reviewDecision normalized to null; GraphQL rollup wrapper supported
    const emptyReview = makeService(
      fakeRunner([JSON.stringify({ ...PULL_REQUEST, reviewDecision: "" })]).run,
    )
    await expect(emptyReview.detailedStatus("thread-1")).resolves.toEqual({
      status: "ok",
      branch: "feat/pr",
      pr: { ...PULL_REQUEST, reviewDecision: null },
    })

    expect(
      summarizeStatusCheckRollup({
        contexts: {
          nodes: [
            { status: "COMPLETED", conclusion: "NEUTRAL" },
            { status: "QUEUED", conclusion: null },
          ],
        },
      }),
    ).toEqual({ total: 2, passed: 1, failed: 0, pending: 1 })
    expect(summarizeStatusCheckRollup(null)).toBeUndefined()
  })
})
