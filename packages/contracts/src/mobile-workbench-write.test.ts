import { describe, expect, it } from "vitest"
import {
  MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT,
  MOBILE_WORKBENCH_LABEL_MAX,
  MOBILE_WORKBENCH_PR_BODY_MAX,
  MOBILE_WORKBENCH_PR_TITLE_MAX,
  MOBILE_WORKBENCH_WRITE_CHUNK_BYTES,
  MOBILE_WORKBENCH_WRITE_INLINE_MAX,
  MOBILE_WORKBENCH_WRITE_MAX_BYTES,
  commandSchemas,
  mobileCheckpointCreateParams,
  mobileCheckpointCreateResult,
  mobileCheckpointListParams,
  mobileCheckpointListResult,
  mobileCheckpointRestoreParams,
  mobileCheckpointRestoreResult,
  mobileFeatures,
  mobilePrCloseParams,
  mobilePrCommentParams,
  mobilePrCommentResult,
  mobilePrCreateParams,
  mobilePrMergeParams,
  mobilePrReadyParams,
  mobilePrReopenParams,
  mobileWorkbenchWriteJsonSchemas,
  mobileWorkbenchWriteMethods,
  mobileWorkspaceCreateFileParams,
  mobileWorkspaceDeletePathParams,
  mobileWorkspaceDeletePathResult,
  mobileWorkspaceReadFileResult,
  mobileWorkspaceRenamePathParams,
  mobileWorkspaceRenamePathResult,
  mobileWorkspaceWriteChunkParams,
  mobileWorkspaceWriteChunkResult,
  mobileWorkspaceWriteCommitParams,
  mobileWorkspaceWriteFileParams,
  mobileWorkspaceWriteFileResult,
  mobileWorkspaceWriteStartParams,
  mobileWorkspaceWriteStartResult,
  mobileWorktreeCreateParams,
  mobileWorktreeCreateResult,
  mobileWorktreeListParams,
  mobileWorktreeListResult,
  mobileWorktreeRemoveParams,
  mobileWorktreeRemoveResult,
  mobileWorktreeSwitchParams,
  mobileWorktreeSwitchResult,
  pullRequestInfoSchema,
} from "./index"

const VALID_SHA256 = "a".repeat(64)

describe("mobile workbench.write contracts", () => {
  it("declares workbench.write feature, all 20 methods, and extended desktop commands & domain schemas", () => {
    expect(mobileFeatures).toContain("workbench.write")
    expect(mobileWorkbenchWriteMethods).toEqual({
      writeFile: "mobile.workspace.writeFile",
      writeStart: "mobile.workspace.writeStart",
      writeChunk: "mobile.workspace.writeChunk",
      writeCommit: "mobile.workspace.writeCommit",
      createFile: "mobile.workspace.createFile",
      renamePath: "mobile.workspace.renamePath",
      deletePath: "mobile.workspace.deletePath",
      worktreeList: "mobile.worktree.list",
      worktreeCreate: "mobile.worktree.create",
      worktreeSwitch: "mobile.worktree.switch",
      worktreeRemove: "mobile.worktree.remove",
      checkpointList: "mobile.checkpoint.list",
      checkpointCreate: "mobile.checkpoint.create",
      checkpointRestore: "mobile.checkpoint.restore",
      prCreate: "mobile.pr.create",
      prComment: "mobile.pr.comment",
      prMerge: "mobile.pr.merge",
      prReady: "mobile.pr.ready",
      prClose: "mobile.pr.close",
      prReopen: "mobile.pr.reopen",
    })

    // pullRequestInfoSchema accepts optional isDraft
    expect(
      pullRequestInfoSchema.parse({
        number: 1,
        url: "https://github.com/pigcode/pigcode/pull/1",
        state: "OPEN",
        title: "Draft PR",
        headRefName: "feat/a",
        baseRefName: "main",
        isDraft: true,
      }).isDraft,
    ).toBe(true)

    // mobileWorkspaceReadFileResult accepts optional mtimeMs (including fractional float)
    expect(
      mobileWorkspaceReadFileResult.parse({
        path: "README.md",
        mode: "text",
        totalSize: 5,
        binary: false,
        truncated: false,
        text: "hello",
        eol: "lf",
        mtimeMs: 1732500000123.45,
      }).mtimeMs,
    ).toBe(1732500000123.45)

    // Desktop commandSchemas extensions
    expect(
      commandSchemas["workspace.createFile"].parse({ threadId: "th_1", path: "a.ts", text: "" }),
    ).toEqual({ threadId: "th_1", path: "a.ts", text: "" })
    expect(
      commandSchemas["workspace.renamePath"].parse({
        projectId: "proj_1",
        oldPath: "a.ts",
        newPath: "b.ts",
      }),
    ).toEqual({ projectId: "proj_1", oldPath: "a.ts", newPath: "b.ts" })
    expect(
      commandSchemas["workspace.deletePath"].parse({
        threadId: "th_1",
        path: "tmp",
        recursive: true,
      }),
    ).toEqual({ threadId: "th_1", path: "tmp", recursive: true })
    expect(
      commandSchemas["pr.create"].parse({ threadId: "th_1", title: "PR", draft: true }),
    ).toMatchObject({ draft: true })
    expect(
      commandSchemas["pr.comment"].parse({ threadId: "th_1", body: "  LGTM  " }),
    ).toEqual({ threadId: "th_1", body: "LGTM" })
    expect(
      commandSchemas["pr.merge"].parse({
        threadId: "th_1",
        method: "squash",
        deleteBranch: true,
      }),
    ).toEqual({ threadId: "th_1", method: "squash", deleteBranch: true })
    expect(commandSchemas["pr.ready"].parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
    expect(commandSchemas["pr.close"].parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
    expect(commandSchemas["pr.reopen"].parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
  })

  it("validates workspace file write, chunked write, create, rename, and delete schemas strictly", () => {
    // Inline writeFile
    expect(
      mobileWorkspaceWriteFileParams.parse({
        threadId: "th_1",
        path: "src/app.ts",
        text: "export const a = 1\n",
        expectedMtimeMs: 1700000000.5,
        eol: "lf",
      }),
    ).toEqual({
      threadId: "th_1",
      path: "src/app.ts",
      text: "export const a = 1\n",
      expectedMtimeMs: 1700000000.5,
      eol: "lf",
    })
    // UTF-8 boundary check: 32 KiB ASCII accepted, +1 byte rejected; CJK > 32 KiB UTF-8 rejected
    expect(
      mobileWorkspaceWriteFileParams.safeParse({
        threadId: "th_1",
        path: "a.txt",
        text: "a".repeat(MOBILE_WORKBENCH_WRITE_INLINE_MAX),
      }).success,
    ).toBe(true)
    expect(
      mobileWorkspaceWriteFileParams.safeParse({
        threadId: "th_1",
        path: "a.txt",
        text: "a".repeat(MOBILE_WORKBENCH_WRITE_INLINE_MAX + 1),
      }).success,
    ).toBe(false)
    expect(
      mobileWorkspaceWriteFileParams.safeParse({
        threadId: "th_1",
        path: "a.txt",
        text: "中".repeat(Math.floor(MOBILE_WORKBENCH_WRITE_INLINE_MAX / 3) + 1),
      }).success,
    ).toBe(false)
    expect(
      mobileWorkspaceWriteFileParams.safeParse({
        threadId: "th_1",
        path: "a.txt",
        text: "ok",
        extra: true,
      }).success,
    ).toBe(false)

    expect(
      mobileWorkspaceWriteFileResult.parse({ path: "src/app.ts", size: 19, mtimeMs: 1234.5 }),
    ).toEqual({ path: "src/app.ts", size: 19, mtimeMs: 1234.5 })

    // Chunked writeStart / writeChunk / writeCommit
    expect(
      mobileWorkspaceWriteStartParams.parse({
        threadId: "th_1",
        path: "big.ts",
        totalBytes: MOBILE_WORKBENCH_WRITE_MAX_BYTES,
        sha256: VALID_SHA256,
        expectedMtimeMs: 100,
        eol: "crlf",
      }),
    ).toMatchObject({ totalBytes: MOBILE_WORKBENCH_WRITE_MAX_BYTES, sha256: VALID_SHA256 })
    expect(
      mobileWorkspaceWriteStartParams.safeParse({
        threadId: "th_1",
        path: "big.ts",
        totalBytes: MOBILE_WORKBENCH_WRITE_MAX_BYTES + 1,
        sha256: VALID_SHA256,
      }).success,
    ).toBe(false)
    expect(
      mobileWorkspaceWriteStartParams.safeParse({
        threadId: "th_1",
        path: "big.ts",
        totalBytes: 10,
        sha256: "INVALID",
      }).success,
    ).toBe(false)
    expect(
      mobileWorkspaceWriteStartResult.parse({
        sessionId: "sess_1",
        chunkBytes: MOBILE_WORKBENCH_WRITE_CHUNK_BYTES,
      }),
    ).toEqual({ sessionId: "sess_1", chunkBytes: MOBILE_WORKBENCH_WRITE_CHUNK_BYTES })

    const maxChunkBase64 = Buffer.alloc(MOBILE_WORKBENCH_WRITE_CHUNK_BYTES, 0x61).toString("base64")
    const overChunkBase64 = Buffer.alloc(MOBILE_WORKBENCH_WRITE_CHUNK_BYTES + 1, 0x61).toString(
      "base64",
    )
    expect(
      mobileWorkspaceWriteChunkParams.parse({
        sessionId: "sess_1",
        offset: 0,
        dataBase64: maxChunkBase64,
      }),
    ).toEqual({ sessionId: "sess_1", offset: 0, dataBase64: maxChunkBase64 })
    expect(
      mobileWorkspaceWriteChunkParams.safeParse({
        sessionId: "sess_1",
        offset: 0,
        dataBase64: overChunkBase64,
      }).success,
    ).toBe(false)
    expect(
      mobileWorkspaceWriteChunkParams.safeParse({
        sessionId: "sess_1",
        offset: 0,
        dataBase64: "",
      }).success,
    ).toBe(false)
    expect(mobileWorkspaceWriteChunkResult.parse({ receivedBytes: 24576 })).toEqual({
      receivedBytes: 24576,
    })
    expect(mobileWorkspaceWriteCommitParams.parse({ sessionId: "sess_1" })).toEqual({
      sessionId: "sess_1",
    })

    // createFile / renamePath / deletePath
    expect(
      mobileWorkspaceCreateFileParams.parse({ threadId: "th_1", path: "new.ts", text: "hi" }),
    ).toEqual({ threadId: "th_1", path: "new.ts", text: "hi" })
    expect(
      mobileWorkspaceRenamePathParams.parse({
        threadId: "th_1",
        oldPath: "a.ts",
        newPath: "b.ts",
      }),
    ).toEqual({ threadId: "th_1", oldPath: "a.ts", newPath: "b.ts" })
    expect(
      mobileWorkspaceRenamePathResult.parse({ oldPath: "a.ts", newPath: "b.ts" }),
    ).toEqual({ oldPath: "a.ts", newPath: "b.ts" })
    expect(
      mobileWorkspaceDeletePathParams.parse({
        threadId: "th_1",
        path: "dir",
        recursive: true,
      }),
    ).toEqual({ threadId: "th_1", path: "dir", recursive: true })
    expect(
      mobileWorkspaceDeletePathResult.parse({ path: "dir", deleted: true }),
    ).toEqual({ path: "dir", deleted: true })
    expect(
      mobileWorkspaceDeletePathResult.safeParse({ path: "dir", deleted: false }).success,
    ).toBe(false)
  })

  it("validates worktree, checkpoint, and PR write schemas strictly", () => {
    const wt = { id: "wt_1", name: "repo-pigcode-abc", branch: "pigcode/1234", active: true }
    expect(mobileWorktreeListParams.parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
    expect(mobileWorktreeListResult.parse({ worktrees: [wt], mainActive: false })).toEqual({
      worktrees: [wt],
      mainActive: false,
    })
    expect(mobileWorktreeCreateParams.parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
    expect(mobileWorktreeCreateResult.parse({ worktree: wt })).toEqual({ worktree: wt })
    expect(
      mobileWorktreeSwitchParams.parse({ threadId: "th_1", worktreeId: "wt_1" }),
    ).toEqual({ threadId: "th_1", worktreeId: "wt_1" })
    expect(mobileWorktreeSwitchResult.parse({ worktree: wt })).toEqual({ worktree: wt })
    expect(mobileWorktreeRemoveParams.parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
    expect(mobileWorktreeRemoveResult.parse({ removed: true })).toEqual({ removed: true })

    // Checkpoints
    const cp = {
      id: "ck_1",
      runId: null,
      phase: "manual" as const,
      label: "Before refactor",
      createdAt: "2026-11-25T10:00:00.000Z",
      restorable: true,
    }
    expect(mobileCheckpointListParams.parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
    expect(mobileCheckpointListResult.parse({ checkpoints: [cp] })).toEqual({ checkpoints: [cp] })
    expect(
      mobileCheckpointCreateParams.parse({ threadId: "th_1", label: "  manual save  " }),
    ).toEqual({ threadId: "th_1", label: "manual save" })
    expect(
      mobileCheckpointCreateParams.safeParse({
        threadId: "th_1",
        label: "x".repeat(MOBILE_WORKBENCH_LABEL_MAX + 1),
      }).success,
    ).toBe(false)
    expect(mobileCheckpointCreateResult.parse({ checkpoint: cp })).toEqual({ checkpoint: cp })
    expect(
      mobileCheckpointRestoreParams.parse({ threadId: "th_1", checkpointId: "ck_1" }),
    ).toEqual({ threadId: "th_1", checkpointId: "ck_1" })
    expect(
      mobileCheckpointRestoreResult.parse({
        checkpointId: "ck_1",
        affectedCount: 60,
        affectedPaths: Array.from(
          { length: MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT },
          (_, i) => `file-${i}.ts`,
        ),
      }).affectedPaths,
    ).toHaveLength(MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT)
    expect(
      mobileCheckpointRestoreResult.safeParse({
        checkpointId: "ck_1",
        affectedCount: 60,
        affectedPaths: Array.from(
          { length: MOBILE_WORKBENCH_CHECKPOINT_AFFECTED_LIMIT + 1 },
          (_, i) => `file-${i}.ts`,
        ),
      }).success,
    ).toBe(false)

    // PR writes
    expect(
      mobilePrCreateParams.parse({
        threadId: "th_1",
        title: "  Add workbench write  ",
        body: "details",
        base: " main ",
        draft: true,
      }),
    ).toEqual({
      threadId: "th_1",
      title: "Add workbench write",
      body: "details",
      base: "main",
      draft: true,
    })
    expect(
      mobilePrCreateParams.safeParse({
        threadId: "th_1",
        title: "   ",
      }).success,
    ).toBe(false)
    expect(
      mobilePrCreateParams.safeParse({
        threadId: "th_1",
        title: "a".repeat(MOBILE_WORKBENCH_PR_TITLE_MAX + 1),
      }).success,
    ).toBe(false)
    expect(
      mobilePrCreateParams.safeParse({
        threadId: "th_1",
        title: "ok",
        body: "a".repeat(MOBILE_WORKBENCH_PR_BODY_MAX + 1),
      }).success,
    ).toBe(false)
    expect(mobilePrCommentParams.parse({ threadId: "th_1", body: "  Nice!  " })).toEqual({
      threadId: "th_1",
      body: "Nice!",
    })
    expect(mobilePrCommentParams.safeParse({ threadId: "th_1", body: "   " }).success).toBe(false)
    expect(mobilePrCommentResult.parse({ ok: true })).toEqual({ ok: true })
    expect(
      mobilePrMergeParams.parse({ threadId: "th_1", method: "rebase", deleteBranch: false }),
    ).toEqual({ threadId: "th_1", method: "rebase", deleteBranch: false })
    expect(
      mobilePrMergeParams.safeParse({ threadId: "th_1", method: "fast-forward" }).success,
    ).toBe(false)
    expect(mobilePrReadyParams.parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
    expect(mobilePrCloseParams.parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
    expect(mobilePrReopenParams.parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
  })

  it("exports JSON schemas for all workbench.write models", () => {
    const schemas = mobileWorkbenchWriteJsonSchemas()
    expect(schemas).toHaveProperty("MobileWorkspaceWriteFileParams")
    expect(schemas).toHaveProperty("MobileWorkspaceWriteStartParams")
    expect(schemas).toHaveProperty("MobileWorkspaceWriteChunkParams")
    expect(schemas).toHaveProperty("MobileWorkspaceWriteCommitParams")
    expect(schemas).toHaveProperty("MobileWorktreeListResult")
    expect(schemas).toHaveProperty("MobileCheckpointRestoreResult")
    expect(schemas).toHaveProperty("MobilePrMergeParams")
  })
})
