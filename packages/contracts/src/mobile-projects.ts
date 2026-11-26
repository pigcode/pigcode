/** 手机端项目管理协议：基于电脑用户主目录相对路径的只读目录浏览与项目增删改。 */
import { z } from "zod"

export const MOBILE_PROJECT_BROWSE_LIMIT = 200
export const MOBILE_PROJECT_SHORTCUT_LIMIT = 6
export const MOBILE_PROJECT_NAME_MAX_LENGTH = 120
export const MOBILE_PROJECT_REL_PATH_MAX_LENGTH = 1024

export const mobileProjectMethods = {
  list: "mobile.project.list",
  browseDirs: "mobile.project.browseDirs",
  add: "mobile.project.add",
  rename: "mobile.project.rename",
  remove: "mobile.project.remove",
} as const

const key = z.string().min(1).max(128)

/**
 * 校验相对电脑用户主目录 `~` 的标准化路径：
 * - 允许 `""` 表示主目录本身（用于 browseDirs）；
 * - 拒绝绝对路径、Windows 盘符、反斜杠、控制字符、`..`/`.` 分段以及隐藏点目录。
 */
export function isValidMobileHomeRelPath(value: string): boolean {
  if (value.length === 0) return true
  if (value.length > MOBILE_PROJECT_REL_PATH_MAX_LENGTH) return false
  if (value.includes("\0") || value.includes("\r") || value.includes("\n")) return false
  if (value.includes("\\")) return false
  if (value.startsWith("/") || value.startsWith("~") || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split("/")
  for (const seg of segments) {
    if (seg.length === 0 || seg === "." || seg === ".." || seg.startsWith(".")) return false
  }
  return true
}

export const mobileHomeRelPathSchema = z
  .string()
  .max(MOBILE_PROJECT_REL_PATH_MAX_LENGTH)
  .refine(isValidMobileHomeRelPath, {
    message: "relPath must be a normalized non-hidden path relative to the home directory",
  })

export const mobileNonEmptyHomeRelPathSchema = z
  .string()
  .min(1)
  .max(MOBILE_PROJECT_REL_PATH_MAX_LENGTH)
  .refine(isValidMobileHomeRelPath, {
    message: "relPath must be a non-empty normalized path relative to the home directory",
  })

export const mobileProjectShortcutSchema = z
  .object({
    label: z.string().min(1).max(80),
    relPath: mobileHomeRelPathSchema,
    displayPath: z.string().min(1).max(MOBILE_PROJECT_REL_PATH_MAX_LENGTH + 4),
  })
  .strict()

export const mobileProjectDirEntrySchema = z
  .object({
    name: z.string().min(1).max(255),
    relPath: mobileNonEmptyHomeRelPathSchema,
    isGitRepo: z.boolean(),
    alreadyAddedProjectId: key.nullable(),
    hasChildren: z.boolean(),
  })
  .strict()

/** 手机端项目管理摘要：仅暴露相对主目录展示路径 displayPath，不返回原始系统绝对路径。 */
export const mobileManagedProjectSchema = z
  .object({
    id: key,
    name: z.string().min(1).max(MOBILE_PROJECT_NAME_MAX_LENGTH),
    displayPath: z.string().min(1).max(MOBILE_PROJECT_REL_PATH_MAX_LENGTH + 4),
    createdAt: z.string().min(1),
    threadCount: z.number().int().nonnegative(),
  })
  .strict()

export const mobileProjectManageListParams = z.object({}).strict()
export const mobileProjectManageListResult = z
  .object({
    projects: z.array(mobileManagedProjectSchema),
  })
  .strict()

export const mobileProjectBrowseDirsParams = z
  .object({
    relPath: mobileHomeRelPathSchema.optional(),
  })
  .strict()

export const mobileProjectBrowseDirsResult = z
  .object({
    currentRelPath: mobileHomeRelPathSchema,
    displayPath: z.string().min(1).max(MOBILE_PROJECT_REL_PATH_MAX_LENGTH + 4),
    parentRelPath: mobileHomeRelPathSchema.nullable(),
    shortcuts: z.array(mobileProjectShortcutSchema),
    entries: z.array(mobileProjectDirEntrySchema),
    truncated: z.boolean(),
  })
  .strict()

export const mobileProjectAddParams = z
  .object({
    relPath: mobileNonEmptyHomeRelPathSchema,
    name: z.string().trim().min(1).max(MOBILE_PROJECT_NAME_MAX_LENGTH).optional(),
  })
  .strict()

export const mobileProjectAddResult = z
  .object({
    project: mobileManagedProjectSchema,
  })
  .strict()

export const mobileProjectRenameParams = z
  .object({
    projectId: key,
    name: z.string().trim().min(1).max(MOBILE_PROJECT_NAME_MAX_LENGTH),
  })
  .strict()

export const mobileProjectRenameResult = z
  .object({
    project: mobileManagedProjectSchema,
  })
  .strict()

export const mobileProjectRemoveParams = z
  .object({
    projectId: key,
  })
  .strict()

export const mobileProjectRemoveResult = z
  .object({
    removed: z.literal(true),
    projectId: key,
  })
  .strict()

export type MobileProjectMethod = (typeof mobileProjectMethods)[keyof typeof mobileProjectMethods]
export type MobileProjectShortcut = z.infer<typeof mobileProjectShortcutSchema>
export type MobileProjectDirEntry = z.infer<typeof mobileProjectDirEntrySchema>
export type MobileManagedProject = z.infer<typeof mobileManagedProjectSchema>
export type MobileProjectManageListParams = z.infer<typeof mobileProjectManageListParams>
export type MobileProjectManageListResult = z.infer<typeof mobileProjectManageListResult>
export type MobileProjectBrowseDirsParams = z.infer<typeof mobileProjectBrowseDirsParams>
export type MobileProjectBrowseDirsResult = z.infer<typeof mobileProjectBrowseDirsResult>
export type MobileProjectAddParams = z.infer<typeof mobileProjectAddParams>
export type MobileProjectAddResult = z.infer<typeof mobileProjectAddResult>
export type MobileProjectRenameParams = z.infer<typeof mobileProjectRenameParams>
export type MobileProjectRenameResult = z.infer<typeof mobileProjectRenameResult>
export type MobileProjectRemoveParams = z.infer<typeof mobileProjectRemoveParams>
export type MobileProjectRemoveResult = z.infer<typeof mobileProjectRemoveResult>
