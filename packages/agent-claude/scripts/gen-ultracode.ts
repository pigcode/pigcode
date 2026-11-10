/**
 * 生成 src/ultracode-models.ts：问本机的 Claude Code 哪些模型能打开 Ultracode。
 *
 * 用法（仓库根目录）：pnpm gen:ultracode [--all] [--claude <可执行文件>]
 *
 * - 默认只问表里还没有的模型：出了新模型跑一次就够，已经问过的不再问。--all 全部重问。
 * - 需要已安装并登录的 Claude Code。会话不发送消息；具体型号每个要一秒左右（CLI 要校验模型）。
 * - 不进构建和 CI，用户那边运行时只查生成的表，不再逐个问。
 */
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ULTRACODE_MODELS } from "../src/ultracode-models.ts"
import { askUltracode } from "../src/ultracode.ts"

const OUTPUT = fileURLToPath(new URL("../src/ultracode-models.ts", import.meta.url))
const TIMEOUT_MS = 180_000

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** --claude 指定的，否则在 PATH 里找。 */
function claudeExecutable(): string {
  const given = argValue("--claude")
  if (given) return given
  const finder = process.platform === "win32" ? "where" : "which"
  const found = execFileSync(finder, ["claude"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim()
  if (!found) throw new Error("claude not found on PATH; pass --claude <path>")
  return found
}

/** 不发送任何消息的输入流；只为让 SDK 完成初始化、回答控制请求。 */
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

function render(table: Map<string, boolean>, cli: string, date: string): string {
  const rows = [...table.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, available]) => `  ${JSON.stringify(id)}: ${available},`)
  return [
    "/**",
    " * 哪些 Claude 模型能打开 Ultracode。由 `pnpm gen:ultracode` 生成（scripts/gen-ultracode.ts），不要手改。",
    ` * 最近一次：Claude Code ${cli}，${date}。`,
    " *",
    " * 键是真实模型 id（别名按 resolvedModel，去掉「[1m]」后缀，见 ultracode.ts 的 realModelId）。",
    " * false 也记下，脚本下次就不再问它；表里没有的模型按不支持处理。",
    " */",
    "export const ULTRACODE_MODELS: Readonly<Record<string, boolean>> = {",
    ...rows,
    "}",
    "",
  ].join("\n")
}

async function main(): Promise<void> {
  const executable = claudeExecutable()
  const cli = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim().split(/\s/)[0]
  const table = new Map<string, boolean>(
    process.argv.includes("--all") ? [] : Object.entries(ULTRACODE_MODELS),
  )
  const input = idleInput()
  // Ultracode 要靠 Workflows；有的账号默认没开，不打开的话所有模型都会答「不能」。
  const stream = query({
    prompt: input.iterable,
    options: { pathToClaudeCodeExecutable: executable, settings: { enableWorkflows: true } },
  })
  const timer = setTimeout(() => {
    console.error(`timed out after ${TIMEOUT_MS / 1000}s`)
    process.exit(1)
  }, TIMEOUT_MS)
  try {
    const models = await stream.supportedModels()
    const before = table.size
    const supported = await askUltracode(stream, models, table, (id, available) =>
      console.log(`${available ? "yes" : "no "}  ${id}`),
    )
    if (!supported)
      throw new Error(`Claude Code ${cli} cannot answer get_settings.ultracodeAvailable`)
    const added = table.size - before
    if (added === 0 && !process.argv.includes("--all")) {
      console.log(`no new models (${table.size} known); nothing to write`)
      return
    }
    writeFileSync(OUTPUT, render(table, cli ?? "unknown", new Date().toISOString().slice(0, 10)))
    console.log(`wrote ${table.size} models (${added} new) to ${OUTPUT}`)
  } finally {
    clearTimeout(timer)
    input.close()
    stream.close()
  }
}

await main()
