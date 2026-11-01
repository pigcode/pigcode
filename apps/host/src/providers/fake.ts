/** 确定性的 fake provider，用于验证协议、UI 和插件模型。 */
import type { ProviderCapabilities } from "@pigcode/contracts"
import { randomUUID } from "node:crypto"
import type {
  CreateSessionInput,
  ProviderDriver,
  ProviderModelInfo,
  ProviderRuntime,
  ProviderSessionHandle,
  UserInput,
} from "./driver"
import {
  FAKE_SCRIPT_TEXT,
  FAKE_SUBAGENT_TEXT,
  fakeScript,
  fakeSubagentScript,
  runFakeScript,
} from "./fake-script"
import { FAKE_BROWSER_PREFIX, runFakeBrowser, type FakeToolCaller } from "./fake-browser"
import { FAKE_SHOWCASE_TEXT, fakeShowcaseScript } from "./fake-showcase"

/** fake provider 固定输出的文本分片。 */
const CHUNKS = ["Hello", " from", " fake", " provider"]

/** 长跑输入的标记；用于验证 run 中断与进程清理。 */
export const FAKE_LONG_RUN_TEXT = "long"
export { FAKE_SCRIPT_TEXT, FAKE_SHOWCASE_TEXT, FAKE_SUBAGENT_TEXT }

/**
 * fake provider 的模型目录：一个可调思考深度，一个不可调，用来覆盖两种界面状态。
 * 模型说明和真实 provider 的目录一样用英文。
 */
export const FAKE_MODELS: ProviderModelInfo[] = [
  {
    id: "fake-sage",
    displayName: "Fake Sage",
    description: "Deterministic replies, adjustable thinking effort",
    isDefault: true,
    efforts: ["low", "medium", "high", "max"],
    defaultEffort: "medium",
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

/** fake provider 的运行选项；E2E 用固定延迟制造可观察的后台运行窗口。 */
export interface FakeProviderOptions {
  /** 每次 send 前的延迟毫秒数；缺省时读取 PIGCODE_FAKE_DELAY_MS。 */
  delayMs?: number
  /** 脚本化回复里每个工具的耗时；缺省时读取 PIGCODE_FAKE_STEP_MS。 */
  stepMs?: number
  /** 以线程身份调用 MCP 工具；浏览器脚本用它操作内置浏览器。 */
  callTool?: FakeToolCaller
}

/** 不依赖外部进程的确定性 provider 实现。 */
export class FakeProviderDriver implements ProviderDriver {
  readonly id = "fake"
  readonly displayName = "Fake Provider"
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    approvals: false,
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
  private readonly callTool: FakeToolCaller | undefined

  constructor(options: FakeProviderOptions = {}) {
    this.delayMs = options.delayMs ?? envMs("PIGCODE_FAKE_DELAY_MS")
    this.stepMs = options.stepMs ?? envMs("PIGCODE_FAKE_STEP_MS", 600)
    this.callTool = options.callTool
  }

  /** 创建一个仅存在于内存中的 provider 会话句柄。 */
  async createSession(input: CreateSessionInput): Promise<ProviderSessionHandle> {
    return {
      id: `ps_${randomUUID()}`,
      threadId: input.threadId,
      cwd: input.cwd,
      nativeSessionId: input.nativeSessionId ?? null,
      permissionMode: input.permissionMode ?? "workspace-write",
      model: input.model ?? null,
    }
  }

  /** 固定的模型目录。 */
  async listModels(): Promise<ProviderModelInfo[]> {
    return FAKE_MODELS
  }

  /** 依次推送开始、分片、完成事件；`long` 输入持续输出直到被 abort，`tools` 输入走脚本。 */
  async send(
    session: ProviderSessionHandle,
    input: UserInput,
    runtime: ProviderRuntime,
  ): Promise<void> {
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

  /** fake provider 没有可中断的工作。 */
  async interrupt(): Promise<void> {}

  /** fake provider 没有需要释放的资源。 */
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

/** 先问两个问题（一个多选、一个单选），再按回答给出结论。 */
async function runFakeQuestions(runtime: ProviderRuntime): Promise<void> {
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
async function runUntilAborted(runtime: ProviderRuntime): Promise<void> {
  while (!runtime.signal.aborted) {
    runtime.emit({ type: "message.delta", text: "." })
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}
