/**
 * 哪些模型能打开 Ultracode：不写死名单，问 CLI。
 *
 * Claude Code 的 `get_settings` 控制请求会在 `applied.ultracodeAvailable` 里说明当前模型能不能打开
 * Ultracode（「Workflows 已开启并且模型支持」），它的协议说明写着宿主应当只在它为 true 时提供 Ultracode
 * 开关。SDK 的 Query 有 getSettings()，只是没写进类型。模型信息里没有对应字段，所以逐个 setModel 再问。
 *
 * 别名（default、opus……）问起来几十毫秒，具体型号每个要一秒左右（CLI 要校验模型）。读目录时先在
 * 时间预算内问，剩下的在后台接着问，结果按「CLI + 配置目录」记住，下一次读目录就是准的；还没问到的
 * 模型先当作不支持。2.1.304 与 2.1.321 实测都有这个字段；更早的 CLI 没有时，一个模型都不标。
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

/** 模型的真实 id：别名用 SDK 给的 resolvedModel，同一个模型的别名和全名只问一次。 */
export function realModelId(model: Pick<ModelInfo, "value" | "resolvedModel">): string {
  return model.resolvedModel ?? model.value
}

/** 一份 CLI 配置下已经问过的结果：真实模型 id → 能不能打开 Ultracode。 */
export type UltracodeAnswers = Map<string, boolean>

/** 按 CLI 与配置目录记住的结果；进程内共享，读目录的会话关掉后也还在。 */
const answers = new Map<string, UltracodeAnswers>()

/** 某份 CLI 配置的结果表。 */
export function ultracodeAnswers(key: string): UltracodeAnswers {
  let table = answers.get(key)
  if (!table) {
    table = new Map()
    answers.set(key, table)
  }
  return table
}

/** 测试用：清空记住的结果。 */
export function resetUltracodeAnswers(): void {
  answers.clear()
}

/**
 * 按目录顺序逐个问还没问过的模型，直到 deadline。返回 false 表示 CLI 不支持这个查询，不用再问；
 * 返回 true 表示问完了或时间到了（剩下的留给下一次）。
 */
export async function askUltracode(
  stream: Query,
  models: readonly ModelInfo[],
  table: UltracodeAnswers,
  deadline: number,
): Promise<boolean> {
  if (typeof (stream as unknown as SettingsReader).getSettings !== "function") return false
  for (const model of models) {
    if (!model.value || table.has(realModelId(model))) continue
    if (Date.now() >= deadline) return true
    await stream.setModel(model.value)
    const state = await readUltracode(stream)
    if (state?.available === undefined) return false
    table.set(realModelId(model), state.available)
  }
  return true
}
