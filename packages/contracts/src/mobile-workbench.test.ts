import { describe, expect, it } from "vitest"
import {
  MOBILE_WORKBENCH_LIST_MAX_LIMIT,
  MOBILE_WORKBENCH_READ_MAX_LENGTH,
  MOBILE_WORKBENCH_SEARCH_MAX_LIMIT,
  MOBILE_WORKBENCH_SEARCH_PREVIEW_MAX,
  MOBILE_WORKBENCH_SEARCH_QUERY_MAX,
  mobileFeatures,
  mobilePrStatusParams,
  mobilePrStatusResult,
  mobileWorkbenchJsonSchemas,
  mobileWorkbenchMethods,
  mobileWorkspaceListParams,
  mobileWorkspaceListResult,
  mobileWorkspaceReadFileParams,
  mobileWorkspaceReadFileResult,
  mobileWorkspaceSearchParams,
  mobileWorkspaceSearchResult,
} from "./index"

describe("mobile workbench.read contracts", () => {
  it("declares workbench.read in mobileFeatures and exposes workbench method names", () => {
    expect(mobileFeatures).toContain("workbench.read")
    expect(mobileWorkbenchMethods).toEqual({
      list: "mobile.workspace.list",
      readFile: "mobile.workspace.readFile",
      search: "mobile.workspace.search",
      prStatus: "mobile.pr.status",
    })
  })

  it("validates mobile.workspace.list params and result strictly", () => {
    expect(mobileWorkspaceListParams.parse({ threadId: "th_1" })).toEqual({
      threadId: "th_1",
      path: "",
    })
    expect(
      mobileWorkspaceListParams.parse({
        threadId: "th_1",
        path: "src/lib",
        offset: 50,
        limit: MOBILE_WORKBENCH_LIST_MAX_LIMIT,
      }),
    ).toEqual({
      threadId: "th_1",
      path: "src/lib",
      offset: 50,
      limit: MOBILE_WORKBENCH_LIST_MAX_LIMIT,
    })

    expect(mobileWorkspaceListParams.safeParse({ threadId: "" }).success).toBe(false)
    expect(mobileWorkspaceListParams.safeParse({ threadId: "th_1", offset: -1 }).success).toBe(false)
    expect(mobileWorkspaceListParams.safeParse({ threadId: "th_1", limit: 0 }).success).toBe(false)
    expect(
      mobileWorkspaceListParams.safeParse({
        threadId: "th_1",
        limit: MOBILE_WORKBENCH_LIST_MAX_LIMIT + 1,
      }).success,
    ).toBe(false)
    expect(mobileWorkspaceListParams.safeParse({ threadId: "th_1", extra: true }).success).toBe(false)

    const result = {
      path: "src",
      entries: [
        { path: "src/components", name: "components", kind: "directory" as const, ignored: true as const },
        { path: "src/index.ts", name: "index.ts", kind: "file" as const, symlink: true as const, size: 1024 },
      ],
      truncated: true,
      nextOffset: 2,
    }
    expect(mobileWorkspaceListResult.parse(result)).toEqual(result)
    expect(
      mobileWorkspaceListResult.safeParse({
        ...result,
        entries: [{ path: "src/a.ts", name: "a.ts", kind: "file", ignored: false }],
      }).success,
    ).toBe(false)
    expect(mobileWorkspaceListResult.safeParse({ ...result, extra: 1 }).success).toBe(false)
  })

  it("validates mobile.workspace.readFile params and result strictly", () => {
    expect(mobileWorkspaceReadFileParams.parse({ threadId: "th_1", path: "README.md" })).toEqual({
      threadId: "th_1",
      path: "README.md",
    })
    expect(
      mobileWorkspaceReadFileParams.parse({
        threadId: "th_1",
        path: "assets/logo.png",
        offset: 0,
        length: MOBILE_WORKBENCH_READ_MAX_LENGTH,
        mode: "image",
        variant: "thumb",
      }),
    ).toEqual({
      threadId: "th_1",
      path: "assets/logo.png",
      offset: 0,
      length: MOBILE_WORKBENCH_READ_MAX_LENGTH,
      mode: "image",
      variant: "thumb",
    })

    expect(mobileWorkspaceReadFileParams.safeParse({ threadId: "th_1", path: "" }).success).toBe(false)
    expect(
      mobileWorkspaceReadFileParams.safeParse({
        threadId: "th_1",
        path: "a.ts",
        length: MOBILE_WORKBENCH_READ_MAX_LENGTH + 1,
      }).success,
    ).toBe(false)
    expect(
      mobileWorkspaceReadFileParams.safeParse({ threadId: "th_1", path: "a.ts", mode: "binary" })
        .success,
    ).toBe(false)

    const textResult = {
      path: "src/main.dart",
      mode: "text" as const,
      totalSize: 512,
      binary: false,
      truncated: true,
      text: "void main() {}",
      eol: "lf" as const,
      languageHint: "dart",
      nextOffset: 14,
    }
    expect(mobileWorkspaceReadFileResult.parse(textResult)).toEqual(textResult)

    const imageResult = {
      path: "assets/pic.png",
      mode: "image" as const,
      totalSize: 4096,
      binary: true,
      truncated: false,
      mimeType: "image/png" as const,
      dataBase64: "iVBORw0KGgo=",
      width: 640,
      height: 480,
    }
    expect(mobileWorkspaceReadFileResult.parse(imageResult)).toEqual(imageResult)
    expect(
      mobileWorkspaceReadFileResult.safeParse({ ...imageResult, mimeType: "image/svg+xml" }).success,
    ).toBe(false)

    const binaryResult = {
      path: "bin/app",
      mode: "binary" as const,
      totalSize: 8192,
      binary: true,
      truncated: false,
    }
    expect(mobileWorkspaceReadFileResult.parse(binaryResult)).toEqual(binaryResult)
  })

  it("validates mobile.workspace.search params and result strictly", () => {
    expect(mobileWorkspaceSearchParams.parse({ threadId: "th_1", query: "  TODO  " })).toEqual({
      threadId: "th_1",
      query: "TODO",
    })
    expect(mobileWorkspaceSearchParams.safeParse({ threadId: "th_1", query: "   " }).success).toBe(false)
    expect(
      mobileWorkspaceSearchParams.safeParse({
        threadId: "th_1",
        query: "a".repeat(MOBILE_WORKBENCH_SEARCH_QUERY_MAX + 1),
      }).success,
    ).toBe(false)
    expect(
      mobileWorkspaceSearchParams.safeParse({
        threadId: "th_1",
        query: "x",
        limit: MOBILE_WORKBENCH_SEARCH_MAX_LIMIT + 1,
      }).success,
    ).toBe(false)

    const result = {
      query: "TODO",
      matches: [{ path: "src/app.ts", line: 12, preview: "// TODO: wire workbench" }],
      truncated: false,
    }
    expect(mobileWorkspaceSearchResult.parse(result)).toEqual(result)
    expect(
      mobileWorkspaceSearchResult.safeParse({
        query: "TODO",
        matches: [{ path: "src/app.ts", line: 0, preview: "x" }],
        truncated: false,
      }).success,
    ).toBe(false)
    expect(
      mobileWorkspaceSearchResult.safeParse({
        query: "TODO",
        matches: [
          {
            path: "src/app.ts",
            line: 1,
            preview: "a".repeat(MOBILE_WORKBENCH_SEARCH_PREVIEW_MAX + 1),
          },
        ],
        truncated: false,
      }).success,
    ).toBe(false)
  })

  it("validates mobile.pr.status params and result strictly", () => {
    expect(mobilePrStatusParams.parse({ threadId: "th_1" })).toEqual({ threadId: "th_1" })
    expect(mobilePrStatusParams.safeParse({ threadId: "" }).success).toBe(false)

    const okResult = {
      status: "ok" as const,
      branch: "feat/mobile-workbench",
      pr: {
        number: 149,
        title: "Add mobile workbench.read protocol",
        state: "OPEN",
        url: "https://github.com/pigcode/pigcode/pull/149",
        headRefName: "feat/mobile-workbench",
        baseRefName: "main",
        isDraft: false,
        additions: 320,
        deletions: 12,
        changedFiles: 8,
        reviewDecision: "APPROVED",
        checksSummary: { total: 4, passed: 3, failed: 0, pending: 1 },
        updatedAt: "2026-11-25T12:00:00Z",
      },
    }
    expect(mobilePrStatusResult.parse(okResult)).toEqual(okResult)
    expect(mobilePrStatusResult.parse({ status: "not-git", branch: null })).toEqual({
      status: "not-git",
      branch: null,
    })
    expect(mobilePrStatusResult.safeParse({ status: "unknown", branch: null }).success).toBe(false)
  })

  it("exports JSON schemas without error", () => {
    const schemas = mobileWorkbenchJsonSchemas()
    expect(schemas).toHaveProperty("MobileWorkspaceListParams")
    expect(schemas).toHaveProperty("MobileWorkspaceListResult")
    expect(schemas).toHaveProperty("MobileWorkspaceReadFileParams")
    expect(schemas).toHaveProperty("MobileWorkspaceReadFileResult")
    expect(schemas).toHaveProperty("MobileWorkspaceSearchParams")
    expect(schemas).toHaveProperty("MobileWorkspaceSearchResult")
    expect(schemas).toHaveProperty("MobilePrStatusParams")
    expect(schemas).toHaveProperty("MobilePrStatusResult")
  })
})
