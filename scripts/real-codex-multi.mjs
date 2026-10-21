/** 真实 Codex 多会话：两个线程并行运行，默认使用 gpt-6.1-sol。 */
import { spawnSync } from "node:child_process"

if (process.env.PIGCODE_REAL_CODEX !== "1") {
  console.log("skip: set PIGCODE_REAL_CODEX=1 to run the real Codex multi-session test")
  process.exit(0)
}

const model = process.env.PIGCODE_CODEX_MODEL ?? "gpt-6.1-sol"
const result = spawnSync(
  "pnpm",
  // vitest 以仓库根目录为 root 读取 vitest.config.ts，文件名也按根目录相对路径匹配。
  ["exec", "vitest", "run", "apps/host/src/providers/multi-session.real.test.ts"],
  {
    stdio: "inherit",
    env: { ...process.env, PIGCODE_REAL_CODEX: "1", PIGCODE_CODEX_MODEL: model },
  },
)
process.exit(result.status ?? 1)
