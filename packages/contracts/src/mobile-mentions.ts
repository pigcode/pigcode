import { z } from "zod"

export const mobileMentionMethods = {
  searchPaths: "workspace.searchPaths",
  agentCommands: "agent.commands",
} as const

export const mobileSearchPathsDefaultLimit = 20
export const mobileSearchPathsMaxLimit = 50
export const mobileSearchPathsQueryLimit = 256
export const mobileMentionPathLimit = 4096
export const mobileMentionFrameBytes = 48 * 1024
export const mobileAgentCommandTextLimit = 256
export const mobileAgentCommandDescriptionLimit = 512
export const mobileAgentCommandShortLimit = 256

const key = z.string().min(1)

export const mobilePathEntryKind = z.enum(["file", "dir"])

export const mobilePathEntry = z.strictObject({
  path: z.string().min(1).max(mobileMentionPathLimit),
  kind: mobilePathEntryKind,
})

export const mobileSearchPathsParams = z
  .strictObject({
    threadId: key.optional(),
    projectId: key.optional(),
    query: z.string().max(mobileSearchPathsQueryLimit).default(""),
    limit: z.int().min(1).max(mobileSearchPathsMaxLimit).optional(),
    refresh: z.boolean().optional(),
  })
  .refine(
    (value) => (value.threadId === undefined) !== (value.projectId === undefined),
    { message: "needs exactly one of threadId or projectId" },
  )

export const mobileSearchPathsResult = z.strictObject({
  entries: z.array(mobilePathEntry),
  truncated: z.boolean(),
})

export const mobileAgentCommandKind = z.enum(["command", "skill"])

export const mobileAgentCommandSource = z.enum([
  "builtin",
  "custom",
  "user",
  "project",
  "plugin",
  "system",
])

export const mobileAgentCommand = z
  .strictObject({
    name: z.string().min(1).max(mobileAgentCommandTextLimit),
    text: z.string().min(1).max(mobileAgentCommandTextLimit),
    kind: mobileAgentCommandKind,
    displayName: z.string().min(1).max(mobileAgentCommandShortLimit).optional(),
    description: z.string().min(1).max(mobileAgentCommandDescriptionLimit).optional(),
    shortDescription: z.string().min(1).max(mobileAgentCommandShortLimit).optional(),
    argumentHint: z.string().min(1).max(mobileAgentCommandShortLimit).optional(),
    source: mobileAgentCommandSource.optional(),
  })
  .refine(
    (value) => (value.kind === "skill" ? value.text.startsWith("$") : value.text.startsWith("/")),
    { message: "command text prefix must match kind" },
  )

export const mobileAgentCommandsParams = z
  .strictObject({
    instanceId: key,
    threadId: key.optional(),
    projectId: key.optional(),
    refresh: z.boolean().optional(),
  })
  .refine(
    (value) => !(value.threadId !== undefined && value.projectId !== undefined),
    { message: "threadId and projectId cannot both be set" },
  )

export const mobileAgentCommandsResult = z.strictObject({
  commands: z.array(mobileAgentCommand),
  truncated: z.boolean(),
})

export type MobilePathEntryKind = z.infer<typeof mobilePathEntryKind>
export type MobilePathEntry = z.infer<typeof mobilePathEntry>
export type MobileSearchPathsParams = z.infer<typeof mobileSearchPathsParams>
export type MobileSearchPathsResult = z.infer<typeof mobileSearchPathsResult>
export type MobileAgentCommandKind = z.infer<typeof mobileAgentCommandKind>
export type MobileAgentCommandSource = z.infer<typeof mobileAgentCommandSource>
export type MobileAgentCommand = z.infer<typeof mobileAgentCommand>
export type MobileAgentCommandsParams = z.infer<typeof mobileAgentCommandsParams>
export type MobileAgentCommandsResult = z.infer<typeof mobileAgentCommandsResult>

export const mobileMentionModels = {
  MobilePathEntryKind: mobilePathEntryKind,
  MobilePathEntry: mobilePathEntry,
  MobileSearchPathsParams: mobileSearchPathsParams,
  MobileSearchPathsResult: mobileSearchPathsResult,
  MobileAgentCommandKind: mobileAgentCommandKind,
  MobileAgentCommandSource: mobileAgentCommandSource,
  MobileAgentCommand: mobileAgentCommand,
  MobileAgentCommandsParams: mobileAgentCommandsParams,
  MobileAgentCommandsResult: mobileAgentCommandsResult,
}

export function mobileMentionsJsonSchemas() {
  const registry = z.registry<{ id: string }>()
  for (const [id, schema] of Object.entries(mobileMentionModels)) registry.add(schema, { id })
  return z.toJSONSchema(registry).schemas
}
