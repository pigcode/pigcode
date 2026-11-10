/**
 * 哪些 Claude 模型能打开 Ultracode。由 `pnpm gen:ultracode` 生成（scripts/gen-ultracode.ts），不要手改。
 * 最近一次：Claude Code 2.1.321，2026-11-10。
 *
 * 键是真实模型 id（别名按 resolvedModel，去掉「[1m]」后缀，见 ultracode.ts 的 realModelId）。
 * false 也记下，脚本下次就不再问它；表里没有的模型按不支持处理。
 */
export const ULTRACODE_MODELS: Readonly<Record<string, boolean>> = {
  "claude-fable-5": true,
  "claude-fable-5-1": true,
  "claude-fable-5-2": true,
  "claude-haiku-4-5-20251001": false,
  "claude-haiku-5-5": true,
  "claude-opus-4-6": false,
  "claude-opus-4-7": true,
  "claude-opus-4-8": true,
  "claude-opus-5": true,
  "claude-opus-5-5": true,
  "claude-sonnet-4-6": false,
  "claude-sonnet-5": true,
  "claude-sonnet-5-5": true,
}
