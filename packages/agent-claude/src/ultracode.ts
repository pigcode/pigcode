/**
 * 问 Claude Code 哪些模型能打开 Ultracode。
 *
 * Claude Code 的 `get_settings` 控制请求会在 `applied.ultracodeAvailable` 里说明当前模型能不能打开
 * Ultracode（「Workflows 已开启并且模型支持」），它的协议说明写着宿主应当只在它为 true 时提供 Ultracode
 * 开关。SDK 的 Query 有 getSettings()，只是没写进类型。模型信息里没有对应字段，所以要逐个 setModel 再问。
 *
 * 逐个问要开一个会话、每个具体型号等一秒左右，不适合每次读模型目录都做。所以这一步由开发者用
 * `pnpm gen:ultracode`（scripts/gen-ultracode.ts）在出新模型时跑一次，结果写进 ultracode-models.ts；
 * 运行时只查那张表，打开 Ultracode 的 run 再用 readUltracode 确认一下这一轮真的开起来了。
 *
 * 这个文件只用类型导入，生成脚本可以直接用 Node 加载它。
 */
import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk"

/** get_settings 返回里用到的部分。 */
interface AppliedSettings {
  applied?: { ultracode?: unknown; ultracodeRequested?: unknown; ultracodeAvailable?: unknown }
}

/** SDK 运行时有、类型里没有的方法。 */
interface SettingsReader {
  getSettings?: () => Promise<AppliedSettings | undefined>
}

/** 读当前会话的 Ultracode 状态；CLI 不支持 get_settings 或没有这个字段时返回 undefined。 */
export async function readUltracode(
  stream: Query,
): Promise<{ available?: boolean; active?: boolean } | undefined> {
  const reader = stream as unknown as SettingsReader
  if (typeof reader.getSettings !== "function") return undefined
  const applied = (await reader.getSettings())?.applied
  if (!applied || typeof applied.ultracodeAvailable !== "boolean") return undefined
  return {
    available: applied.ultracodeAvailable,
    ...(typeof applied.ultracode === "boolean" ? { active: applied.ultracode } : {}),
  }
}

/**
 * 查表用的模型 id：别名用 SDK 给的 resolvedModel，去掉「[1m]」这类上下文窗口后缀，
 * 同一个模型的别名、全名和长上下文版本共用一条记录。
 */
export function realModelId(model: Pick<ModelInfo, "value" | "resolvedModel">): string {
  return (model.resolvedModel ?? model.value).replace(/\[[^\]]*\]$/, "")
}

/**
 * 按目录顺序逐个问 table 里还没有的模型，答案写进 table。
 * 返回 false 表示这个 CLI 回答不了（没有 get_settings 或没有这个字段）。
 */
export async function askUltracode(
  stream: Query,
  models: readonly ModelInfo[],
  table: Map<string, boolean>,
  onAnswer: (id: string, available: boolean) => void = () => undefined,
): Promise<boolean> {
  if (typeof (stream as unknown as SettingsReader).getSettings !== "function") return false
  for (const model of models) {
    const id = realModelId(model)
    if (!model.value || table.has(id)) continue
    await stream.setModel(model.value)
    const state = await readUltracode(stream)
    if (state?.available === undefined) return false
    table.set(id, state.available)
    onAnswer(id, state.available)
  }
  return true
}
