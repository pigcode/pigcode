/** 定义 Host 接受的命令参数；M0-A 只包含真实用到的命令。 */
import { z } from "zod"

/** 命令方法到参数 schema 的映射。 */
export const commandSchemas = {
  "project.add": z.object({ rootPath: z.string().min(1) }),
  "project.list": z.object({}),
  "thread.create": z.object({
    projectId: z.string().min(1),
    title: z.string().min(1).default("New thread"),
    providerId: z.string().min(1).default("fake"),
  }),
  "thread.list": z.object({ projectId: z.string().min(1).optional() }),
  "run.start": z.object({ threadId: z.string().min(1), text: z.string().min(1) }),
  "run.interrupt": z.object({ threadId: z.string().min(1), runId: z.string().min(1) }),
  "thread.subscribe": z.object({
    threadId: z.string().min(1),
    cursor: z.number().int().nonnegative().default(0),
  }),
} as const

/** 所有命令方法名的联合类型。 */
export type CommandMethod = keyof typeof commandSchemas
/** 指定命令方法的参数类型。 */
export type CommandParams<M extends CommandMethod> = z.infer<(typeof commandSchemas)[M]>

/** 校验命令参数；未知命令返回 null。 */
export function parseCommandParams(method: string, params: unknown): unknown | null {
  if (!(method in commandSchemas)) return null
  const schema = commandSchemas[method as CommandMethod]
  return schema.parse(params)
}
