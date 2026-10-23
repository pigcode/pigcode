/**
 * 真实 provider 冒烟：用已安装、已登录的 CLI 跑最小 prompt，验证流式、结果和用量。
 * 用法：node scripts/real-smoke.ts <claude | codex | codex-multi>
 * 没有设置对应的 PIGCODE_REAL_* 时直接跳过，默认不消耗额度。
 */
import { spawnSync } from "node:child_process"

/** 一种冒烟目标：开关变量、vitest 文件与额外环境变量。 */
interface SmokeTarget {
  flag: "PIGCODE_REAL_CLAUDE" | "PIGCODE_REAL_CODEX"
  description: string
  testFile: string
  env?: Record<string, string>
}

const targets: Record<string, SmokeTarget> = {
  claude: {
    flag: "PIGCODE_REAL_CLAUDE",
    description: "real Claude smoke test",
    testFile: "apps/host/src/providers/claude/real-smoke.test.ts",
  },
  codex: {
    flag: "PIGCODE_REAL_CODEX",
    description: "real Codex smoke test",
    testFile: "apps/host/src/providers/codex/real-smoke.test.ts",
  },
  // 两个线程并行运行，默认使用 gpt-6.1-sol。
  "codex-multi": {
    flag: "PIGCODE_REAL_CODEX",
    description: "real Codex multi-session test",
    testFile: "apps/host/src/providers/multi-session.real.test.ts",
    env: { PIGCODE_CODEX_MODEL: process.env.PIGCODE_CODEX_MODEL ?? "gpt-6.1-sol" },
  },
}

const name = process.argv[2] ?? ""
const target = targets[name]
if (!target) {
  console.error(`usage: node scripts/real-smoke.ts <${Object.keys(targets).join(" | ")}>`)
  process.exit(1)
}

if (process.env[target.flag] !== "1") {
  console.log(`skip: set ${target.flag}=1 to run the ${target.description}`)
  process.exit(0)
}

const result = spawnSync(
  "pnpm",
  // vitest 以仓库根目录为 root 读取 vitest.config.ts，文件名也按根目录相对路径匹配。
  ["exec", "vitest", "run", target.testFile],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, [target.flag]: "1", ...target.env },
  },
)
process.exit(result.status ?? 1)
