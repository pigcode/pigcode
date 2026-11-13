/** 定义 Host 接受的命令参数；M0-A 只包含真实用到的命令。 */
import { z } from "zod"
import { agentInstancePatchSchema, agentSettingsValuesSchema } from "./agents"
import { permissionModeSchema, reasoningEffortSchema, scheduleRuleSchema } from "./domain"

/** 分支选择器使用完整 ref，避免同名的本地分支、远端分支或 tag 混淆。 */
const worktreeStart = z.object({
  baseRef: z
    .string()
    .max(4096)
    .regex(/^refs\/(heads|remotes)\/.+/)
    .optional(),
})

export type WorktreeStart = z.infer<typeof worktreeStart>

export interface GitBranches {
  currentBranch: string | null
  head: string | null
  localBranches: string[]
  remoteBranches: string[]
}

/** 定时任务的标题：可以留空。 */
const scheduleTitle = z.string().trim().max(120)
/** 结束日期；null 表示永不结束。 */
const scheduleEndsAt = z.string().datetime().nullable()

/**
 * 右侧面板与终端看的是哪个目录：会话里传 threadId（会话的工作目录，可能是 worktree）；
 * 新会话草稿里还没有会话，传草稿的 projectId（项目根目录）。两个只能给一个。
 */
const workspaceScope = {
  threadId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
}

/** 给带 workspaceScope 的参数加上「threadId 与 projectId 只给一个」的检查。 */
function scoped<T extends z.ZodRawShape>(shape: T) {
  return z.object({ ...workspaceScope, ...shape }).refine(
    (value) => {
      // T 是泛型，推不出这两个字段一定在；它们来自上面的 workspaceScope。
      const owner = value as { threadId?: string; projectId?: string }
      return (owner.threadId === undefined) !== (owner.projectId === undefined)
    },
    { message: "needs exactly one of threadId or projectId" },
  )
}

/** 只读检测；refresh 跳过缓存重新运行，agentId 只检测这个 agent，instanceId 只检测这个实例。 */
const agentDetectParams = z.object({
  agentId: z.string().min(1).optional(),
  instanceId: z.string().min(1).optional(),
  refresh: z.boolean().optional(),
})
/** `agent.registered` 不带参数，返回已注册 driver 的 agent：id、名字与 Agent 功能。 */
const agentRegisteredParams = z.object({})
/** `agent.default` 不带参数，返回新会话默认使用的 agent `{ id, instanceId }`；没有可用的 agent 时 id 为 null。 */
const agentDefaultParams = z.object({})
/** 一个 agent 实例的模型目录，含用户添加的自定义模型；只给 instanceId 时由 Host 找出它的 agent。 */
const agentModelsParams = z.object({
  agentId: z.string().min(1).optional(),
  instanceId: z.string().min(1).optional(),
})
/** 换 Agent 或模型；返回 `{ agentId, instanceId, modelId, handoff, forkFromNativeSessionId }`。 */
const threadSwitchAgentParams = z.object({
  threadId: z.string().min(1),
  agentId: z.string().min(1),
  instanceId: z.string().min(1).nullish(),
  modelId: z.string().min(1).nullish(),
})

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
  /** 项目根目录里的文件（相对路径）；新会话草稿还没有会话时，输入框的 @ 引用用它。 */
  "project.files": z.object({ projectId: z.string().min(1) }),
  "thread.create": z.object({
    projectId: z.string().min(1),
    title: z.string().min(1).default("New thread"),
    agentId: z.string().min(1).default("fake"),
    /** 用这个 Agent 的哪个实例；缺省时用默认实例。 */
    instanceId: z.string().min(1).optional(),
    /** 在这个主会话下添加子代理；子代理继承主会话的项目、工作目录与最近的对话摘要。 */
    parentThreadId: z.string().min(1).optional(),
    /** 新会话草稿里选好的模型；缺省用 agent 的默认模型。 */
    modelId: z.string().min(1).optional(),
    /** 新会话草稿里选好的权限模式；缺省是 workspace-write。 */
    permissionMode: permissionModeSchema.optional(),
    planMode: z.boolean().optional(),
    /** 新会话在独立 worktree 中启动；没有 baseRef 时使用项目当前 HEAD。 */
    worktree: worktreeStart.optional(),
  }),
  "thread.list": z.object({ projectId: z.string().min(1).optional() }),
  "thread.rename": z.object({
    threadId: z.string().min(1),
    title: z.string().min(1).max(120),
  }),
  "thread.archive": z.object({ threadId: z.string().min(1) }),
  "thread.switchAgent": threadSwitchAgentParams,
  /** 下一次 run 起生效；运行中的 run 保持启动时的权限。 */
  "thread.setPermissionMode": z.object({
    threadId: z.string().min(1),
    permissionMode: permissionModeSchema,
  }),
  "thread.setPlanMode": z.object({ threadId: z.string().min(1), planMode: z.boolean() }),
  "run.start": z.object({
    threadId: z.string().min(1),
    text: z.string().min(1),
    /** 本次 run 的思考深度；缺省时用 agent 自己的默认值。 */
    effort: reasoningEffortSchema.optional(),
    /** 本次 run 用快速模式；只对目录里标了 fast 的模型生效，其余 driver 忽略。 */
    fast: z.boolean().optional(),
    /** 本次 run 打开 Ultracode；只对目录里标了 ultracode 的模型生效，其余 driver 忽略。 */
    ultracode: z.boolean().optional(),
    /** 用户在输入框里 @ 引用的会话；Host 给 agent 附上它们的摘要和读取方法。 */
    references: z
      .array(z.object({ kind: z.literal("thread"), threadId: z.string().min(1) }))
      .max(10)
      .optional(),
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
  "agent.cliUpdates": z.object({}),
  "agent.checkCliUpdates": z.object({ instanceId: z.string().min(1).optional() }),
  "agent.updateCli": z.object({ instanceId: z.string().min(1) }),
  "agent.registered": agentRegisteredParams,
  "agent.default": agentDefaultParams,
  "agent.models": agentModelsParams,
  /**
   * 实例在某个工作目录下的 `/` 命令（CLI 命令、skill、自定义命令）。工作目录取线程的，
   * 还没有线程（新会话草稿）时取项目的；都没有时只列用户级的。
   */
  "agent.commands": z.object({
    instanceId: z.string().min(1),
    threadId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
  }),
  /** 设置页的 agent 列表：插件、Agent 功能、设置字段、实例与当前值。 */
  "agent.list": z.object({}),
  /** 整体替换一个实例的设置值；对之后新建的会话、检测与模型目录生效。instanceId 缺省时写默认实例。 */
  "agent.updateSettings": z.object({
    agentId: z.string().min(1),
    instanceId: z.string().min(1).optional(),
    values: agentSettingsValuesSchema,
  }),
  /** 给一个 Agent 新建实例：从默认实例复制设置作为初值，返回新实例。 */
  "agent.createInstance": z.object({
    agentId: z.string().min(1),
    label: z.string().trim().min(1).max(120),
    /** 复制哪个实例的设置；缺省时复制默认实例。 */
    copyFrom: z.string().min(1).optional(),
  }),
  /** 改实例的名称、启用状态或设置；没给的项不变。 */
  "agent.updateInstance": z.object({
    instanceId: z.string().min(1),
    patch: agentInstancePatchSchema,
  }),
  /** 删除实例；默认实例不能删，用到它的会话退回默认实例。 */
  "agent.removeInstance": z.object({ instanceId: z.string().min(1) }),
  /** 新会话默认使用的 agent；null 表示自动挑选第一个可用的。返回 `{ defaultAgentId }`。 */
  "agent.setDefault": z.object({
    agentId: z.string().min(1).nullable(),
    instanceId: z.string().min(1).nullable().optional(),
  }),
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
  /** 安装插件市场里的一项；返回安装的条目。 */
  "plugin.installFromMarketplace": z.object({
    marketplace: z.string().min(1),
    name: z.string().min(1),
  }),
  /** 按记下的来源重新安装用户安装的插件（从远程市场装的先刷新市场），保留配置与启停状态。 */
  "plugin.update": z.object({ id: z.string().min(1) }),
  /** 重新读取插件列表，按当前状态补齐或卸下 Host 入口（插件页的「刷新」）。 */
  "plugin.reload": z.object({}),
  /** 已添加的插件市场与其中的插件；返回 `MarketplaceSummary[]`。 */
  "marketplace.list": z.object({}),
  /** 添加插件市场：GitHub 仓库、git 地址、https 上的 marketplace.json、本地目录或文件。 */
  "marketplace.add": z.object({ source: z.string().trim().min(1) }),
  /** 刷新一个市场；不给 id 时刷新全部。返回刷新后的 `MarketplaceSummary[]`。 */
  "marketplace.refresh": z.object({ id: z.string().min(1).optional() }),
  /** 启用或停用市场：停用的不在插件市场里列出、不随「全部刷新」刷新，从它装的插件保留。 */
  "marketplace.setEnabled": z.object({ id: z.string().min(1), enabled: z.boolean() }),
  /** 删除市场；从它装的插件保留。 */
  "marketplace.remove": z.object({ id: z.string().min(1) }),
  "plugin.bootGraph": z.object({}),
  "workspace.tree": scoped({}),
  /** 工作目录的绝对路径；复制完整路径、在文件管理器中显示时用。 */
  "workspace.root": scoped({}),
  /** 列出一个目录；path 为空表示工作目录本身。 */
  "workspace.list": scoped({ path: z.string().max(4096).default("") }),
  /** 按路径模糊搜索文件与目录。 */
  "workspace.searchPaths": scoped({
    query: z.string().trim().min(1).max(256),
    limit: z.number().int().min(1).max(500).optional(),
    refresh: z.boolean().optional(),
  }),
  /** 读取文件；encoding 为 image 时图片按 base64 返回。 */
  "workspace.readFile": scoped({
    path: z.string().min(1),
    encoding: z.enum(["text", "image"]).optional(),
  }),
  /** 保存编辑；expectedMtimeMs 防止覆盖别处的修改，eol 按原文件的换行符写回。 */
  "workspace.writeFile": scoped({
    path: z.string().min(1),
    text: z.string().max(5 * 1024 * 1024),
    expectedMtimeMs: z.number().nonnegative().optional(),
    eol: z.enum(["lf", "crlf"]).optional(),
  }),
  "workspace.search": scoped({
    query: z.string().min(1),
    glob: z.string().optional(),
  }),
  "git.status": scoped({}),
  "git.branches": z.object({ projectId: z.string().min(1) }),
  "git.switchBranch": z.object({ projectId: z.string().min(1), branch: z.string().min(1) }),
  "git.createBranch": z.object({ projectId: z.string().min(1), branch: z.string().trim().min(1) }),
  "git.diff": scoped({
    base: z.string().min(1),
    head: z.string().min(1),
  }),
  "pr.status": scoped({}),
  "pr.create": scoped({
    title: z.string().min(1),
    body: z.string().optional(),
    base: z.string().min(1).optional(),
  }),
  "schedule.list": z.object({}),
  "schedule.create": z.object({
    threadId: z.string().min(1),
    title: scheduleTitle.default(""),
    prompt: z.string().trim().min(1),
    rule: scheduleRuleSchema,
    endsAt: scheduleEndsAt.default(null),
    enabled: z.boolean().default(true),
  }),
  "schedule.update": z.object({
    id: z.string().min(1),
    title: scheduleTitle.optional(),
    prompt: z.string().trim().min(1).optional(),
    rule: scheduleRuleSchema.optional(),
    endsAt: scheduleEndsAt.optional(),
    enabled: z.boolean().optional(),
  }),
  "schedule.delete": z.object({ id: z.string().min(1) }),
  /** 立即运行一次，不改动原来排好的下一次；返回 `{ status: started | busy | unavailable | failed, runId }`。 */
  "schedule.runNow": z.object({ id: z.string().min(1) }),
  /** 一个任务的运行历史，新的在前；返回 `{ runs, total }`。 */
  "schedule.runs": z.object({
    id: z.string().min(1),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  }),
  "schedule.deleteRun": z.object({ id: z.string().min(1) }),
  "checkpoint.list": z.object({ threadId: z.string().min(1) }),
  "checkpoint.create": z.object({ threadId: z.string().min(1), label: z.string().optional() }),
  "checkpoint.restore": z.object({ threadId: z.string().min(1), checkpointId: z.string().min(1) }),
  "worktree.list": z.object({ threadId: z.string().min(1) }),
  "worktree.create": z.object({ threadId: z.string().min(1) }),
  "worktree.switch": z.object({ threadId: z.string().min(1), path: z.string().min(1) }),
  "worktree.remove": z.object({ threadId: z.string().min(1) }),
  /** 会话里开终端传 threadId；新会话草稿里传草稿的 projectId，终端开在项目根目录。 */
  "terminal.open": scoped({
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
