/** Claude Code 的模型目录：从 SDK 会话读取，读不到时退回 CLI 的模型别名。 */
import type { EffortLevel, ModelInfo, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ReasoningEffort } from "@pigcode/contracts"
import { asReasoningEffort, sortEfforts, type AgentModelInfo } from "@pigcode/plugin-sdk"
import type { ClaudeDetection } from "./detect"

/** 读取目录时注入的依赖；测试替换 query 与检测。 */
export interface ClaudeModelSource {
  queryFn: (params: {
    prompt: string | AsyncIterable<SDKUserMessage>
    options: { pathToClaudeCodeExecutable?: string; env?: Record<string, string | undefined> }
  }) => Query
  executable: string | undefined
  /** 设置页里的环境变量（含 CLAUDE_CONFIG_DIR）；没有覆盖时缺省。 */
  env?: NodeJS.ProcessEnv | undefined
  detect: () => Promise<Pick<ClaudeDetection, "installed" | "loggedIn">>
  timeoutMs?: number
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
    // 读不到目录时按 Opus 系列都支持快速模式与 Ultracode 处理；CLI 不支持时自己忽略。
    fast: true,
    ultracode: true,
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

/** 把 SDK 的 ModelInfo 转成目录条目；第一项是 CLI 的默认选择。 */
export function parseClaudeModels(models: readonly ModelInfo[]): AgentModelInfo[] {
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
        ...(supportsUltracode(model.resolvedModel ?? model.value) ? { ultracode: true } : {}),
      },
    ]
  })
}

/**
 * 支持 Ultracode 的模型：SDK 的模型信息里没有这一项，按真实模型 id 的前缀判断（和 T3 Code 的列表一致，
 * 外加同系列的新版本）。别名用 SDK 给的 resolvedModel 对上。判断错了也无妨：不支持的模型或关掉了
 * Workflows 时，CLI 会静默忽略这个设置（2.1.321 实测）。
 */
const ULTRACODE_MODELS = /^claude-(opus-5|fable-5|opus-4-8)/

/** 这个模型 id 是否支持 Ultracode。 */
export function supportsUltracode(modelId: string): boolean {
  return ULTRACODE_MODELS.test(modelId)
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

/**
 * 读取 Claude Code 的模型目录。只有 CLI 已安装且登录时才启动一次 SDK 会话；
 * 会话不发送消息，读完目录立即关闭，不消耗额度。
 */
export async function listClaudeModels(source: ClaudeModelSource): Promise<AgentModelInfo[]> {
  const detection = await source.detect().catch(() => ({ installed: false, loggedIn: false }))
  if (!detection.installed || !detection.loggedIn) return CLAUDE_FALLBACK_MODELS
  const input = idleInput()
  let stream: Query | undefined
  try {
    stream = source.queryFn({
      prompt: input.iterable,
      options: {
        ...(source.executable ? { pathToClaudeCodeExecutable: source.executable } : {}),
        ...(source.env ? { env: source.env } : {}),
      },
    })
    const models = parseClaudeModels(
      await withTimeout(stream.supportedModels(), source.timeoutMs ?? 15_000),
    )
    return models.length > 0 ? models : CLAUDE_FALLBACK_MODELS
  } catch {
    return CLAUDE_FALLBACK_MODELS
  } finally {
    input.close()
    stream?.close()
  }
}
