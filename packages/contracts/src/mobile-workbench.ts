/** 手机端只读工作台（文件浏览、文件阅读、代码搜索与 PR 状态）的协议定义。 */
import { z } from "zod"
import { attachmentReadVariantSchema, imageAttachmentMimeTypeSchema } from "./attachments"

export const mobileWorkbenchMethods = {
  list: "mobile.workspace.list",
  readFile: "mobile.workspace.readFile",
  search: "mobile.workspace.search",
  prStatus: "mobile.pr.status",
} as const

export const MOBILE_WORKBENCH_PATH_MAX = 4096
export const MOBILE_WORKBENCH_LIST_DEFAULT_LIMIT = 100
export const MOBILE_WORKBENCH_LIST_MAX_LIMIT = 200
export const MOBILE_WORKBENCH_FRAME_BYTES = 48 * 1024
export const MOBILE_WORKBENCH_TEXT_CHUNK_MAX = 24 * 1024
export const MOBILE_WORKBENCH_READ_MAX_LENGTH = 32 * 1024
export const MOBILE_WORKBENCH_SEARCH_QUERY_MAX = 200
export const MOBILE_WORKBENCH_SEARCH_GLOB_MAX = 200
export const MOBILE_WORKBENCH_SEARCH_DEFAULT_LIMIT = 60
export const MOBILE_WORKBENCH_SEARCH_MAX_LIMIT = 100
export const MOBILE_WORKBENCH_SEARCH_PREVIEW_MAX = 200

const key = z.string().min(1)

export const mobileWorkspaceEntryKind = z.enum(["file", "directory"])

export const mobileWorkspaceDirectoryEntry = z.strictObject({
  path: z.string().min(1).max(MOBILE_WORKBENCH_PATH_MAX),
  name: z.string().min(1).max(MOBILE_WORKBENCH_PATH_MAX),
  kind: mobileWorkspaceEntryKind,
  ignored: z.literal(true).optional(),
  symlink: z.literal(true).optional(),
  size: z.int().nonnegative().optional(),
})

export const mobileWorkspaceListParams = z.strictObject({
  threadId: key,
  path: z.string().max(MOBILE_WORKBENCH_PATH_MAX).default(""),
  offset: z.int().nonnegative().optional(),
  limit: z.int().min(1).max(MOBILE_WORKBENCH_LIST_MAX_LIMIT).optional(),
})

export const mobileWorkspaceListResult = z.strictObject({
  path: z.string().max(MOBILE_WORKBENCH_PATH_MAX),
  entries: z.array(mobileWorkspaceDirectoryEntry),
  truncated: z.boolean(),
  nextOffset: z.int().nonnegative().optional(),
})

export const mobileWorkspaceReadMode = z.enum(["auto", "text", "image"])
export const mobileWorkspaceReadResultMode = z.enum(["text", "image", "binary"])
export const mobileWorkspaceFileEol = z.enum(["lf", "crlf"])

export const mobileWorkspaceReadFileParams = z.strictObject({
  threadId: key,
  path: z.string().min(1).max(MOBILE_WORKBENCH_PATH_MAX),
  offset: z.int().nonnegative().optional(),
  length: z.int().min(1).max(MOBILE_WORKBENCH_READ_MAX_LENGTH).optional(),
  mode: mobileWorkspaceReadMode.optional(),
  variant: attachmentReadVariantSchema.optional(),
})

export const mobileWorkspaceReadFileResult = z.strictObject({
  path: z.string().min(1).max(MOBILE_WORKBENCH_PATH_MAX),
  mode: mobileWorkspaceReadResultMode,
  totalSize: z.int().nonnegative(),
  binary: z.boolean(),
  truncated: z.boolean(),
  text: z.string().optional(),
  eol: mobileWorkspaceFileEol.optional(),
  languageHint: z.string().min(1).max(64).optional(),
  mimeType: imageAttachmentMimeTypeSchema.optional(),
  dataBase64: z.string().optional(),
  width: z.int().positive().optional(),
  height: z.int().positive().optional(),
  nextOffset: z.int().nonnegative().optional(),
})

export const mobileWorkspaceSearchParams = z.strictObject({
  threadId: key,
  query: z.string().trim().min(1).max(MOBILE_WORKBENCH_SEARCH_QUERY_MAX),
  glob: z.string().max(MOBILE_WORKBENCH_SEARCH_GLOB_MAX).optional(),
  limit: z.int().min(1).max(MOBILE_WORKBENCH_SEARCH_MAX_LIMIT).optional(),
})

export const mobileWorkspaceSearchMatch = z.strictObject({
  path: z.string().min(1).max(MOBILE_WORKBENCH_PATH_MAX),
  line: z.int().min(1),
  preview: z.string().max(MOBILE_WORKBENCH_SEARCH_PREVIEW_MAX),
})

export const mobileWorkspaceSearchResult = z.strictObject({
  query: z.string().min(1).max(MOBILE_WORKBENCH_SEARCH_QUERY_MAX),
  matches: z.array(mobileWorkspaceSearchMatch),
  truncated: z.boolean(),
})

export const mobilePrStatusParams = z.strictObject({
  threadId: key,
})

export const mobilePrStatusCode = z.enum([
  "ok",
  "no-pr",
  "not-git",
  "no-remote",
  "gh-unavailable",
  "gh-unauthenticated",
])

export const mobilePrChecksSummary = z.strictObject({
  total: z.int().nonnegative(),
  passed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  pending: z.int().nonnegative(),
})

export const mobilePullRequestInfo = z.strictObject({
  number: z.int().positive(),
  title: z.string(),
  state: z.string().min(1),
  url: z.string().min(1),
  headRefName: z.string().min(1),
  baseRefName: z.string().min(1),
  isDraft: z.boolean().optional(),
  additions: z.int().nonnegative().optional(),
  deletions: z.int().nonnegative().optional(),
  changedFiles: z.int().nonnegative().optional(),
  reviewDecision: z.string().nullable().optional(),
  checksSummary: mobilePrChecksSummary.optional(),
  updatedAt: z.string().min(1).optional(),
})

export const mobilePrStatusResult = z.strictObject({
  status: mobilePrStatusCode,
  branch: z.string().min(1).nullable(),
  pr: mobilePullRequestInfo.optional(),
})

export type MobileWorkspaceEntryKind = z.infer<typeof mobileWorkspaceEntryKind>
export type MobileWorkspaceDirectoryEntry = z.infer<typeof mobileWorkspaceDirectoryEntry>
export type MobileWorkspaceListParams = z.infer<typeof mobileWorkspaceListParams>
export type MobileWorkspaceListResult = z.infer<typeof mobileWorkspaceListResult>
export type MobileWorkspaceReadMode = z.infer<typeof mobileWorkspaceReadMode>
export type MobileWorkspaceReadResultMode = z.infer<typeof mobileWorkspaceReadResultMode>
export type MobileWorkspaceFileEol = z.infer<typeof mobileWorkspaceFileEol>
export type MobileWorkspaceReadFileParams = z.infer<typeof mobileWorkspaceReadFileParams>
export type MobileWorkspaceReadFileResult = z.infer<typeof mobileWorkspaceReadFileResult>
export type MobileWorkspaceSearchParams = z.infer<typeof mobileWorkspaceSearchParams>
export type MobileWorkspaceSearchMatch = z.infer<typeof mobileWorkspaceSearchMatch>
export type MobileWorkspaceSearchResult = z.infer<typeof mobileWorkspaceSearchResult>
export type MobilePrStatusParams = z.infer<typeof mobilePrStatusParams>
export type MobilePrStatusCode = z.infer<typeof mobilePrStatusCode>
export type MobilePrChecksSummary = z.infer<typeof mobilePrChecksSummary>
export type MobilePullRequestInfo = z.infer<typeof mobilePullRequestInfo>
export type MobilePrStatusResult = z.infer<typeof mobilePrStatusResult>

export const mobileWorkbenchModels = {
  MobileWorkspaceEntryKind: mobileWorkspaceEntryKind,
  MobileWorkspaceDirectoryEntry: mobileWorkspaceDirectoryEntry,
  MobileWorkspaceListParams: mobileWorkspaceListParams,
  MobileWorkspaceListResult: mobileWorkspaceListResult,
  MobileWorkspaceReadMode: mobileWorkspaceReadMode,
  MobileWorkspaceReadResultMode: mobileWorkspaceReadResultMode,
  MobileWorkspaceFileEol: mobileWorkspaceFileEol,
  MobileWorkspaceReadFileParams: mobileWorkspaceReadFileParams,
  MobileWorkspaceReadFileResult: mobileWorkspaceReadFileResult,
  MobileWorkspaceSearchParams: mobileWorkspaceSearchParams,
  MobileWorkspaceSearchMatch: mobileWorkspaceSearchMatch,
  MobileWorkspaceSearchResult: mobileWorkspaceSearchResult,
  MobilePrStatusParams: mobilePrStatusParams,
  MobilePrStatusCode: mobilePrStatusCode,
  MobilePrChecksSummary: mobilePrChecksSummary,
  MobilePullRequestInfo: mobilePullRequestInfo,
  MobilePrStatusResult: mobilePrStatusResult,
}

export function mobileWorkbenchJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(mobileWorkbenchModels)) registry.add(schema, { id })
  return z.toJSONSchema(registry).schemas
}
