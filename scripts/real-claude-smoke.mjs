/** 真实 Claude 冒烟：跑一个最小 prompt，验证流式、结果和用量。 */
import { spawnSync } from "node:child_process"

if (process.env.PIGCODE_REAL_CLAUDE !== "1") {
  console.log("skip: set PIGCODE_REAL_CLAUDE=1 to run the real Claude smoke test")
  process.exit(0)
}

const result = spawnSync(
  "pnpm",
  // vitest 以仓库根目录为 root 读取 vitest.config.ts，文件名也按根目录相对路径匹配。
  ["exec", "vitest", "run", "apps/host/src/providers/claude/real-smoke.test.ts"],
  { stdio: "inherit", env: { ...process.env, PIGCODE_REAL_CLAUDE: "1" } },
)
process.exit(result.status ?? 1)
