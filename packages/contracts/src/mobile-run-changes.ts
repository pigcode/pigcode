import { z } from "zod"

export const mobileRunChangesMethods = {
  list: "run.changes",
  diff: "run.diff",
} as const

const cursor = z.int().nonnegative()
const path = z.string().min(1).max(4096)
const target = z.strictObject({ threadId: z.string().min(1), runId: z.string().min(1) })

export const mobileRunChangesParams = target.extend({ offset: cursor.optional() })
export const mobileRunDiffParams = mobileRunChangesParams.extend({ path })
export const mobileRunChangedFile = z.strictObject({
  path,
  added: cursor.optional(),
  removed: cursor.optional(),
  binary: z.boolean().optional(),
})
export const mobileRunChangesPage = z.strictObject({
  files: z.array(mobileRunChangedFile),
  diffAvailable: z.boolean(),
  sharedWorktree: z.boolean().optional(),
  nextOffset: cursor.optional(),
})
export const mobileRunDiffPage = z.strictObject({
  text: z.string(),
  nextOffset: cursor.optional(),
})

export type MobileRunChangedFile = z.infer<typeof mobileRunChangedFile>
export type MobileRunChangesParams = z.infer<typeof mobileRunChangesParams>
export type MobileRunDiffParams = z.infer<typeof mobileRunDiffParams>

export function mobileRunChangesJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  registry.add(mobileRunChangesParams, { id: "MobileRunChangesParams" })
  registry.add(mobileRunDiffParams, { id: "MobileRunDiffParams" })
  registry.add(mobileRunChangedFile, { id: "MobileRunChangedFile" })
  registry.add(mobileRunChangesPage, { id: "MobileRunChangesPage" })
  registry.add(mobileRunDiffPage, { id: "MobileRunDiffPage" })
  return z.toJSONSchema(registry).schemas
}
