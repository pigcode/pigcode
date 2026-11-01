/** 定义 Host 接受的命令参数；M0-A 只包含真实用到的命令。 */
import { z } from "zod"
import { agentSettingsValuesSchema } from "./agents"
import { permissionModeSchema, reasoningEffortSchema } from "./domain"

/** 只读检测；refresh 跳过缓存重新运行，providerId 只检测这一个 agent。 */
const agentDetectParams = z.object({
  providerId: z.string().min(1).optional(),
  refresh: z.boolean().optional(),
})
/** `agent.registered` 不带参数，返回已注册 driver 的 agent：id、名字与 Agent 功能。 */
const agentRegisteredParams = z.object({})
/** `agent.default` 不带参数，返回新会话默认使用的 agent `{ id }`；没有可用的 agent 时 id 为 null。 */
const agentDefaultParams = z.object({})
/** 一个 agent 的模型目录，含用户添加的自定义模型。 */
const agentModelsParams = z.object({ providerId: z.string().min(1) })

/** 命令方法到参数 schema 的映射。 */
export const commandSchemas = {
  "project.add": z.object({
    rootPath: z.string().min(1),
    /** 展示名；缺省时取文件夹名。 */
    name: z.string().trim().min(1).max(120).optional(),
  }),
  "project.list": z.object({}),
  "project.rename": z.object({
    projectId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
  }),
  /** 只从侧栏移除；文件夹与会话都保留，再次添加同一路径时恢复。 */
  "project.remove": z.object({ projectId: z.string().min(1) }),
  "thread.create": z.object({
    projectId: z.string().min(1),
    title: z.string().min(1).default("New thread"),
    providerId: z.string().min(1).default("fake"),
    /** 在这个主会话下添加子代理；子代理继承主会话的项目、工作目录与最近的对话摘要。 */
    parentThreadId: z.string().min(1).optional(),
  }),
  "thread.list": z.object({ projectId: z.string().min(1).optional() }),
  "thread.rename": z.object({
    threadId: z.string().min(1),
    title: z.string().min(1).max(120),
  }),
  "thread.archive": z.object({ threadId: z.string().min(1) }),
  "thread.switchProvider": z.object({
    threadId: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1).nullish(),
  }),
  /** 下一次 run 起生效；运行中的 run 保持启动时的权限。 */
  "thread.setPermissionMode": z.object({
    threadId: z.string().min(1),
    permissionMode: permissionModeSchema,
  }),
  "run.start": z.object({
    threadId: z.string().min(1),
    text: z.string().min(1),
    /** 本次 run 的思考深度；缺省时用 agent 自己的默认值。 */
    effort: reasoningEffortSchema.optional(),
  }),
  "run.list": z.object({}),
  "run.interrupt": z.object({ threadId: z.string().min(1), runId: z.string().min(1) }),
  "run.respondApproval": z.object({
    threadId: z.string().min(1),
    runId: z.string().min(1),
    requestId: z.string().min(1),
    decision: z.enum(["allow-once", "allow-for-session", "deny"]),
  }),
  "run.answerQuestion": z.object({
    threadId: z.string().min(1),
    runId: z.string().min(1),
    requestId: z.string().min(1),
    answers: z.array(z.string()),
  }),
  "agent.detect": agentDetectParams,
  "agent.registered": agentRegisteredParams,
  "agent.default": agentDefaultParams,
  "agent.models": agentModelsParams,
  /** 旧名字，转到 `agent.*`；见 commandAliases。 */
  "provider.detect": agentDetectParams,
  "provider.list": agentRegisteredParams,
  "provider.default": agentDefaultParams,
  "provider.models": agentModelsParams,
  /** 设置页的 agent 列表：插件、能力、设置字段与当前值。 */
  "agent.list": z.object({}),
  /** 整体替换一个 agent 的设置值；对之后新建的会话、检测与模型目录生效。 */
  "agent.updateSettings": z.object({
    providerId: z.string().min(1),
    values: agentSettingsValuesSchema,
  }),
  /** 新会话默认使用的 agent；null 表示自动挑选第一个可用的。 */
  "agent.setDefault": z.object({ providerId: z.string().min(1).nullable() }),
  "thread.subscribe": z.object({
    threadId: z.string().min(1),
    cursor: z.number().int().nonnegative().default(0),
  }),
  "thread.unsubscribe": z.object({ threadId: z.string().min(1) }),
  "plugin.list": z.object({}),
  "plugin.install": z.object({ spec: z.string().min(1) }),
  "plugin.installLocal": z.object({ sourceDir: z.string().min(1) }),
  "plugin.enable": z.object({ id: z.string().min(1) }),
  "plugin.disable": z.object({ id: z.string().min(1) }),
  /** 卸载用户安装的插件；内置插件只能停用。 */
  "plugin.uninstall": z.object({ id: z.string().min(1) }),
  "plugin.bootGraph": z.object({}),
  "workspace.tree": z.object({ threadId: z.string().min(1) }),
  /** 线程工作目录的绝对路径；复制完整路径、在文件管理器中显示时用。 */
  "workspace.root": z.object({ threadId: z.string().min(1) }),
  /** 列出一个目录；path 为空表示线程的工作目录。 */
  "workspace.list": z.object({
    threadId: z.string().min(1),
    path: z.string().max(4096).default(""),
  }),
  /** 按路径模糊搜索文件与目录。 */
  "workspace.searchPaths": z.object({
    threadId: z.string().min(1),
    query: z.string().trim().min(1).max(256),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  /** 读取文件；encoding 为 image 时图片按 base64 返回。 */
  "workspace.readFile": z.object({
    threadId: z.string().min(1),
    path: z.string().min(1),
    encoding: z.enum(["text", "image"]).optional(),
  }),
  /** 保存编辑；expectedMtimeMs 防止覆盖别处的修改，eol 按原文件的换行符写回。 */
  "workspace.writeFile": z.object({
    threadId: z.string().min(1),
    path: z.string().min(1),
    text: z.string().max(5 * 1024 * 1024),
    expectedMtimeMs: z.number().nonnegative().optional(),
    eol: z.enum(["lf", "crlf"]).optional(),
  }),
  "workspace.search": z.object({
    threadId: z.string().min(1),
    query: z.string().min(1),
    glob: z.string().optional(),
  }),
  "git.status": z.object({ threadId: z.string().min(1) }),
  "git.diff": z.object({
    threadId: z.string().min(1),
    base: z.string().min(1),
    head: z.string().min(1),
  }),
  "pr.status": z.object({ threadId: z.string().min(1) }),
  "pr.create": z.object({
    threadId: z.string().min(1),
    title: z.string().min(1),
    body: z.string().optional(),
    base: z.string().min(1).optional(),
  }),
  "schedule.list": z.object({}),
  "schedule.create": z.object({
    threadId: z.string().min(1),
    prompt: z.string().min(1),
    intervalSeconds: z.number().int().positive().max(2_147_483),
    enabled: z.boolean().default(true),
  }),
  "schedule.update": z.object({
    id: z.string().min(1),
    prompt: z.string().min(1).optional(),
    intervalSeconds: z.number().int().positive().max(2_147_483).optional(),
    enabled: z.boolean().optional(),
  }),
  "schedule.delete": z.object({ id: z.string().min(1) }),
  "schedule.runNow": z.object({ id: z.string().min(1) }),
  "checkpoint.list": z.object({ threadId: z.string().min(1) }),
  "checkpoint.create": z.object({ threadId: z.string().min(1), label: z.string().optional() }),
  "checkpoint.restore": z.object({ threadId: z.string().min(1), checkpointId: z.string().min(1) }),
  "worktree.list": z.object({ threadId: z.string().min(1) }),
  "worktree.create": z.object({ threadId: z.string().min(1) }),
  "worktree.switch": z.object({ threadId: z.string().min(1), path: z.string().min(1) }),
  "worktree.remove": z.object({ threadId: z.string().min(1) }),
  "terminal.open": z.object({
    threadId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  "terminal.write": z.object({ terminalId: z.string().min(1), data: z.string() }),
  "terminal.resize": z.object({
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive(),
  }),
  "terminal.close": z.object({ terminalId: z.string().min(1) }),
} as const

/**
 * 旧命令名到新命令名：Host 按新名字处理，旧名字和新名字共用参数 schema 与返回值。
 * `provider.list` 对应 `agent.registered`，不是 `agent.list`：后者是设置页的列表，形状不同。
 */
export const commandAliases = {
  "provider.detect": "agent.detect",
  "provider.list": "agent.registered",
  "provider.default": "agent.default",
  "provider.models": "agent.models",
} as const satisfies Partial<Record<keyof typeof commandSchemas, keyof typeof commandSchemas>>

/** 所有命令方法名的联合类型。 */
export type CommandMethod = keyof typeof commandSchemas
/** 只是别名的旧命令名。 */
export type CommandAlias = keyof typeof commandAliases
/** Host 实际处理的命令名。 */
export type CanonicalCommandMethod = Exclude<CommandMethod, CommandAlias>

/** 把旧命令名换成它转到的新命令名；其余原样返回。 */
export function resolveCommandMethod(method: CommandMethod): CanonicalCommandMethod {
  return method in commandAliases
    ? commandAliases[method as CommandAlias]
    : (method as CanonicalCommandMethod)
}

/** 指定命令方法的参数类型。 */
export type CommandParams<M extends CommandMethod> = z.infer<(typeof commandSchemas)[M]>

/** 校验命令参数；未知命令返回 null。 */
export function parseCommandParams(method: string, params: unknown): unknown | null {
  if (!(method in commandSchemas)) return null
  const schema = commandSchemas[method as CommandMethod]
  return schema.parse(params)
}
