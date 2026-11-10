/** Claude Code 的模型目录：从 SDK 会话读取，读不到时退回 CLI 的模型别名。 */
import type { EffortLevel, ModelInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ReasoningEffort } from "@pigcode/contracts"
import { asReasoningEffort, sortEfforts, type AgentModelInfo } from "@pigcode/plugin-sdk"
import type { ClaudeDetection } from "./detect"
import { askUltracode, realModelId, ultracodeAnswers, type UltracodeAnswers } from "./ultracode"

/** 读取目录时注入的依赖；测试替换 query 与检测。 */
export interface ClaudeModelSource {
  queryFn: (params: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options: {
      pathToClaudeCodeExecutable?: string
      env?: Record<string, string | undefined>
      settings?: Record<string, unknown>
    }
  }) => Query
  executable: string | undefined
  /** 设置页里的环境变量（含 CLAUDE_CONFIG_DIR）；没有覆盖时缺省。 */
  env?: NodeJS.ProcessEnv | undefined
  detect: () => Promise<Pick<ClaudeDetection, "installed" | "loggedIn">>
  timeoutMs?: number
  /** 读目录时问 Ultracode 的时间预算；剩下的模型在后台接着问。缺省 1.5 秒。 */
  ultracodeBudgetMs?: number
}

const CLAUDE_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"]

/** CLI 认得的模型别名；SDK 会话读不到目录（未登录、超时）时使用。 */
export const CLAUDE_FALLBACK_MODELS: AgentModelInfo[] = [
  {
    id: "default",
    displayName: "Default",
    // 和 SDK 返回的模型说明一样用英文；模型目录没有多语言字段。
    description: "Claude Code's default model",
    isDefault: true,
    efforts: CLAUDE_EFFORTS,
    defaultEffort: null,
  },
  {
    id: "opus",
    displayName: "Opus",
    isDefault: false,
    efforts: CLAUDE_EFFORTS,
    defaultEffort: null,
    // 读不到目录时按 Opus 系列支持快速模式处理；CLI 不支持时自己退回标准速度。
    fast: true,
  },
  {
    id: "sonnet",
    displayName: "Sonnet",
    isDefault: false,
    efforts: CLAUDE_EFFORTS,
    defaultEffort: null,
  },
  { id: "haiku", displayName: "Haiku", isDefault: false, efforts: [], defaultEffort: null },
]

/**
 * 把 SDK 的 ModelInfo 转成目录条目；第一项是 CLI 的默认选择。
 * ultracode 是问过 CLI 的结果（见 ultracode.ts），没问到的模型不标。
 */
export function parseClaudeModels(
  models: readonly ModelInfo[],
  ultracode: UltracodeAnswers = new Map(),
): AgentModelInfo[] {
  return models.flatMap((model, index): AgentModelInfo[] => {
    if (!model.value) return []
    const efforts =
      model.supportsEffort === false
        ? []
        : sortEfforts(
            (model.supportedEffortLevels ?? []).flatMap((level) => {
              const effort = asReasoningEffort(level)
              return effort ? [effort] : []
            }),
          )
    return [
      {
        id: model.value,
        displayName: model.displayName || model.value,
        ...(model.description ? { description: model.description } : {}),
        isDefault: index === 0,
        efforts,
        defaultEffort: null,
        ...(model.supportsFastMode ? { fast: true } : {}),
        ...(ultracode.get(realModelId(model)) === true ? { ultracode: true } : {}),
      },
    ]
  })
}

/** Claude 认得的档位。 */
const CLAUDE_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"]

/**
 * 换成 Claude 的档位：没有 minimal 与 ultra 档，分别按 low 与 max 处理；其余已知档位同名。
 * none（不思考）Claude 也没有，和别的 agent 才有的档位一样不传。
 * 别的 agent 才有的档位 Claude 不认识，返回 undefined，不传档位，由 CLI 自己决定。
 */
export function toClaudeEffort(effort: ReasoningEffort): EffortLevel | undefined {
  if (effort === "minimal") return "low"
  if (effort === "ultra") return "max"
  return CLAUDE_LEVELS.includes(effort) ? (effort as EffortLevel) : undefined
}

/** 「default」交给 CLI 自己选，不显式传 model。 */
export function claudeModelOption(model: string | null): string | undefined {
  return model && model !== "default" ? model : undefined
}

/** 不发送任何消息的输入流；只为让 SDK 完成初始化、回答目录请求。 */
function idleInput(): { iterable: AsyncIterable<SDKUserMessage>; close: () => void } {
  let release: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    iterable: {
      async *[Symbol.asyncIterator]() {
        await closed
      },
    },
    close: () => release(),
  }
}

/** 超时后放弃等待；SDK 进程在 finally 里关闭。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("claude model list timed out")), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 同一份 CLI 配置（可执行文件、配置目录、API 地址）问过的 Ultracode 结果共用一张表。 */
function answersKey(source: ClaudeModelSource): string {
  const env = source.env ?? {}
  return JSON.stringify([
    source.executable ?? "",
    env.CLAUDE_CONFIG_DIR ?? "",
    env.ANTHROPIC_BASE_URL ?? "",
  ])
}

/**
 * 读取 Claude Code 的模型目录。只有 CLI 已安装且登录时才启动一次 SDK 会话；会话不发送消息，不消耗额度。
 * 读完目录后在预算内问几个模型能不能打开 Ultracode，剩下的在后台问完再关会话，结果记住给下一次用。
 * 会话打开 Workflows：Ultracode 要靠它，run 里打开 Ultracode 时也一起打开。
 */
export async function listClaudeModels(source: ClaudeModelSource): Promise<AgentModelInfo[]> {
  const detection = await source.detect().catch(() => ({ installed: false, loggedIn: false }))
  if (!detection.installed || !detection.loggedIn) return CLAUDE_FALLBACK_MODELS
  const input = idleInput()
  let stream: Query | undefined
  /** 后台还在问的时候由后台负责关会话。 */
  let handedOff = false
  const close = (query: Query | undefined) => {
    input.close()
    query?.close()
  }
  try {
    stream = source.queryFn({
      prompt: input.iterable,
      options: {
        ...(source.executable ? { pathToClaudeCodeExecutable: source.executable } : {}),
        ...(source.env ? { env: source.env } : {}),
        settings: { enableWorkflows: true },
      },
    })
    const timeoutMs = source.timeoutMs ?? 15_000
    const raw = await withTimeout(stream.supportedModels(), timeoutMs)
    const table = ultracodeAnswers(answersKey(source))
    const asking = stream
    const deadline = Date.now() + (source.ultracodeBudgetMs ?? 1_500)
    const supported = await withTimeout(
      askUltracode(asking, raw, table, deadline),
      timeoutMs,
    ).catch(() => false)
    const models = parseClaudeModels(raw, table)
    // 时间到了还有没问的模型：后台接着问，问完再关会话；读目录不等它。
    if (supported && raw.some((model) => model.value && !table.has(realModelId(model)))) {
      handedOff = true
      void withTimeout(askUltracode(asking, raw, table, Infinity), 60_000)
        .catch(() => undefined)
        .finally(() => close(asking))
    }
    return models.length > 0 ? models : CLAUDE_FALLBACK_MODELS
  } catch {
    return CLAUDE_FALLBACK_MODELS
  } finally {
    if (!handedOff) close(stream)
  }
}
