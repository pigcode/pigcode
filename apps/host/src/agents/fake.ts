/** 确定性的 fake agent，用于验证协议、UI 和插件模型。 */
import { FAKE_WORKFLOW_TEXT, fakeWorkflowScript } from "./fake-workflow"
import type { AgentFeatures } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type {
  CreateSessionInput,
  AgentCommandInfo,
  AgentDriver,
  AgentModelInfo,
  AgentRuntime,
  AgentSettingsValues,
  AgentStatus,
  AgentSessionHandle,
  UserInput,
} from "./driver"
import {
  FAKE_SCRIPT_TEXT,
  FAKE_SUBAGENT_TEXT,
  FAKE_TOOL_RENDERERS_TEXT,
  fakeScript,
  fakeSubagentScript,
  fakeToolRenderersScript,
  runFakeScript,
} from "./fake-script"
import { FAKE_BROWSER_PREFIX, runFakeBrowser, type FakeToolCaller } from "./fake-browser"
import { FAKE_SHOWCASE_TEXT, fakeShowcaseScript } from "./fake-showcase"

/** fake agent 固定输出的文本分片。这段文字和下面的 displayName 显示在界面上，E2E 与视觉基线都按它匹配。 */
const CHUNKS = ["Hello", " from", " fake", " agent"]

/** 长跑输入的标记；用于验证 run 中断与进程清理。 */
export const FAKE_LONG_RUN_TEXT = "long"
export {
  FAKE_SCRIPT_TEXT,
  FAKE_SHOWCASE_TEXT,
  FAKE_SUBAGENT_TEXT,
  FAKE_TOOL_RENDERERS_TEXT,
  FAKE_WORKFLOW_TEXT,
}

/**
 * fake agent 的模型目录：一个可调思考深度，一个不可调，用来覆盖两种界面状态。
 * 模型说明和真实 Agent 的目录一样用英文。
 */
export const FAKE_MODELS: AgentModelInfo[] = [
  {
    id: "fake-sage",
    displayName: "Fake Sage",
    description: "Deterministic replies, adjustable thinking effort",
    isDefault: true,
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "medium",
    fast: true,
    ultracode: true,
  },
  {
    id: "fake-swift",
    displayName: "Fake Swift",
    description: "Deterministic replies, no thinking effort",
    isDefault: false,
    efforts: [],
    defaultEffort: null,
  },
]

/** fake agent 的运行选项；E2E 用固定延迟制造可观察的后台运行窗口。 */
export interface FakeAgentOptions {
  /** 每次 send 前的延迟毫秒数；缺省时读取 PIGCODE_FAKE_DELAY_MS。 */
  delayMs?: number
  /** 脚本化回复里每个工具的耗时；缺省时读取 PIGCODE_FAKE_STEP_MS。 */
  stepMs?: number
  /** detect 的耗时；缺省时读取 PIGCODE_FAKE_DETECT_MS。 */
  detectMs?: number
  /** 以线程身份调用 MCP 工具；浏览器脚本用它操作内置浏览器。 */
  callTool?: FakeToolCaller
}

/** 不依赖外部进程的确定性 Agent 实现。 */
export class FakeAgentDriver implements AgentDriver {
  readonly id = "fake"
  readonly displayName = "Fake Agent"
  readonly features: AgentFeatures = {
    streaming: true,
    approvals: true,
    questions: true,
    plan: false,
    resume: false,
    fork: false,
    rollback: false,
    checkpoint: false,
    subagents: false,
    mcp: false,
    images: false,
    usage: false,
    modelCatalog: true,
    nativeSessionId: false,
  }

  private readonly delayMs: number
  private readonly stepMs: number
  private readonly detectMs: number
  private readonly callTool: FakeToolCaller | undefined

  constructor(options: FakeAgentOptions = {}) {
    this.delayMs = options.delayMs ?? envMs("PIGCODE_FAKE_DELAY_MS")
    this.stepMs = options.stepMs ?? envMs("PIGCODE_FAKE_STEP_MS", 600)
    this.detectMs = options.detectMs ?? envMs("PIGCODE_FAKE_DETECT_MS")
    this.callTool = options.callTool
  }

  /** 创建一个仅存在于内存中的 Agent 会话句柄。 */
  async createSession(input: CreateSessionInput): Promise<AgentSessionHandle> {
    return {
      id: `ps_${randomUUID()}`,
      threadId: input.threadId,
      cwd: input.cwd,
      nativeSessionId: input.nativeSessionId ?? null,
      permissionMode: input.permissionMode ?? "workspace-write",
      model: input.model ?? null,
    }
  }

  /** 只读检测；E2E 用 PIGCODE_FAKE_DETECT_MS 把检测卡住，验证界面不等它。 */
  async detect(): Promise<AgentStatus> {
    if (this.detectMs > 0) await new Promise((resolve) => setTimeout(resolve, this.detectMs))
    return { installed: true, version: null, authenticated: true }
  }

  /** 固定的模型目录。 */
  async listModels(): Promise<AgentModelInfo[]> {
    return FAKE_MODELS
  }

  /** 固定的 `/` 命令：一条 CLI 内置命令和一个 skill；cwd 只用来让 E2E 看到它传到了。 */
  async listCommands(
    _settings: AgentSettingsValues,
    cwd: string | null,
  ): Promise<AgentCommandInfo[]> {
    return [
      {
        name: "review",
        text: "/review",
        description: "Review the pending changes",
        kind: "builtin",
      },
      {
        name: "fake-skill",
        text: "/fake-skill",
        description: cwd ? `Fake skill for ${cwd}` : "Fake skill",
        argumentHint: "<topic>",
        kind: "skill",
      },
    ]
  }

  /** 依次推送开始、分片、完成事件；`long` 输入持续输出直到被 abort，`tools` 输入走脚本。 */
  async send(session: AgentSessionHandle, input: UserInput, runtime: AgentRuntime): Promise<void> {
    runtime.emit({ type: "run.started" })
    // E2E 通过 PIGCODE_FAKE_DELAY_MS 拉长运行窗口，默认 0 保持单元测试的同步行为。
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    }
    if (input.text === FAKE_LONG_RUN_TEXT) {
      await runUntilAborted(runtime)
      return
    }
    if (input.text === FAKE_ASK_TEXT) {
      await runFakeQuestions(runtime)
      if (!runtime.signal.aborted) runtime.emit({ type: "run.completed" })
      return
    }
    if (input.text === FAKE_FAIL_TEXT) {
      runtime.emit({ type: "run.failed", message: FAKE_FAIL_MESSAGE })
      return
    }
    if (input.text === FAKE_NOTICE_TEXT) {
      // 和 Codex 的插件桥失败一样：这一轮照常回答，只是先告诉用户工具没接上（#57）。
      runtime.emit({
        type: "notice",
        level: "warning",
        key: "mcp.bridge.failed",
        params: { name: "pigcode" },
      })
      runtime.emit({ type: "message.completed", text: FAKE_NOTICE_TEXT_REPLY })
      runtime.emit({ type: "run.completed" })
      return
    }
    if (input.text === FAKE_APPROVAL_TEXT) {
      await runFakeApproval(runtime)
      if (!runtime.signal.aborted) runtime.emit({ type: "run.completed" })
      return
    }
    if (input.text.startsWith(FAKE_BROWSER_PREFIX)) {
      await runFakeBrowser(runtime, {
        threadId: session.threadId,
        url: input.text.slice(FAKE_BROWSER_PREFIX.length).trim(),
        stepMs: this.stepMs,
        callTool: this.callTool,
      })
      if (!runtime.signal.aborted) runtime.emit({ type: "run.completed" })
      return
    }
    const script =
      input.text === FAKE_SCRIPT_TEXT
        ? fakeScript
        : input.text === FAKE_SUBAGENT_TEXT
          ? fakeSubagentScript
          : input.text === FAKE_SHOWCASE_TEXT
            ? fakeShowcaseScript
            : input.text === FAKE_TOOL_RENDERERS_TEXT
              ? fakeToolRenderersScript
              : input.text === FAKE_WORKFLOW_TEXT
                ? fakeWorkflowScript
                : null
    if (script) {
      await runFakeScript(runtime, this.stepMs, script)
      if (!runtime.signal.aborted) runtime.emit({ type: "run.completed" })
      return
    }
    for (const text of CHUNKS) runtime.emit({ type: "message.delta", text })
    runtime.emit({ type: "message.completed", text: CHUNKS.join("") })
    runtime.emit({ type: "run.completed" })
  }

  /** fake agent 没有可中断的工作。 */
  async interrupt(): Promise<void> {}

  /** fake agent 没有需要释放的资源。 */
  async dispose(): Promise<void> {}
}

/** 从环境变量读取毫秒数；非法值或负数按缺省值处理。 */
function envMs(name: string, fallback = 0): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/** 触发提问脚本的输入。 */
export const FAKE_ASK_TEXT = "ask"

/** 触发失败脚本的输入。 */
export const FAKE_FAIL_TEXT = "fail"

/** 这一轮的失败消息；界面上显示为用户内容。 */
export const FAKE_FAIL_MESSAGE = "这一步没有做成：找不到要修改的文件。"

/** 触发审批脚本的输入。 */
export const FAKE_APPROVAL_TEXT = "approve"

/** 触发会话提示的输入。 */
export const FAKE_NOTICE_TEXT = "notice"

/** 提示那一轮的回答；证明提示不影响对话继续。 */
export const FAKE_NOTICE_TEXT_REPLY = "插件工具这次用不了，其余照常。"

/** 审批脚本里模型说的话；界面上显示为用户内容，英文界面检查靠它区分。 */
export const FAKE_APPROVAL_TEXTS = {
  before: "这一步要先确认一下。",
  title: "运行这条命令？",
  denied: "好，不执行。",
  allowed: "命令已经执行完了。",
}

/** 请求一次命令审批，按用户的决议收尾。 */
async function runFakeApproval(runtime: AgentRuntime): Promise<void> {
  runtime.emit({ type: "message.completed", text: FAKE_APPROVAL_TEXTS.before })
  const decision = await runtime.requestApproval({
    toolName: "Bash",
    title: FAKE_APPROVAL_TEXTS.title,
    description: "pnpm install",
    input: { command: "pnpm install" },
  })
  runtime.emit({
    type: "message.completed",
    text: decision === "deny" ? FAKE_APPROVAL_TEXTS.denied : FAKE_APPROVAL_TEXTS.allowed,
  })
}

/** 先问两个问题（一个多选、一个单选），再按回答给出结论。 */
async function runFakeQuestions(runtime: AgentRuntime): Promise<void> {
  runtime.emit({ type: "message.completed", text: "开始之前先确认两件事。" })
  const answers = runtime.askQuestions
    ? await runtime.askQuestions({
        questions: [
          {
            question: "这次改动要覆盖哪些平台？",
            header: "平台",
            options: [{ label: "macOS" }, { label: "Windows" }, { label: "Linux" }],
            multiSelect: true,
          },
          {
            question: "测试用哪个框架？",
            header: "测试",
            options: [
              { label: "Vitest", description: "和项目现有配置一致" },
              { label: "Jest", description: "需要额外安装依赖" },
            ],
            multiSelect: false,
          },
        ],
      })
    : []
  if (runtime.signal.aborted) return
  runtime.emit({
    type: "message.completed",
    text:
      answers.length === 0
        ? "没有收到回答，先不动手。"
        : `好的：平台 ${answers[0] ?? "未定"}，测试用 ${answers[1] ?? "未定"}。`,
  })
}

/** 循环推送增量直到 run 的取消信号到达；中断后不再 emit。 */
async function runUntilAborted(runtime: AgentRuntime): Promise<void> {
  while (!runtime.signal.aborted) {
    runtime.emit({ type: "message.delta", text: "." })
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
