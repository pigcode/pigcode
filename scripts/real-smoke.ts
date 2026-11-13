/**
 * 真实 Agent 冒烟：用已安装、已登录的 CLI 跑最小 prompt，验证流式、结果和用量。
 * 用法：node scripts/real-smoke.ts <claude | codex | codex-multi | mcp-tools>
 * 没有设置对应的 PIGCODE_REAL_* 时直接跳过，默认不消耗额度。
 */
import { spawnSync } from "node:child_process"

/** 一种冒烟目标：开关变量、vitest 文件与额外环境变量。 */
interface SmokeTarget {
  /** 任意一个为 1 就运行；测试自己按各自的开关跳过没有启用的 Agent。 */
  flags: readonly ("PIGCODE_REAL_CLAUDE" | "PIGCODE_REAL_CODEX")[]
  description: string
  testFile: string
  env?: Record<string, string>
}

const targets: Record<string, SmokeTarget> = {
  claude: {
    flags: ["PIGCODE_REAL_CLAUDE"],
    description: "real Claude smoke test",
    testFile: "packages/agent-claude/src/real-smoke.test.ts",
  },
  codex: {
    flags: ["PIGCODE_REAL_CODEX"],
    description: "real Codex smoke test",
    testFile: "packages/agent-codex/src/real-smoke.test.ts",
  },
  // 两个线程并行运行，默认使用 gpt-6.1-sol。
  "codex-multi": {
    flags: ["PIGCODE_REAL_CODEX"],
    description: "real Codex multi-session test",
    testFile: "apps/host/src/agents/multi-session.real.test.ts",
    env: { PIGCODE_CODEX_MODEL: process.env.PIGCODE_CODEX_MODEL ?? "gpt-6.1-sol" },
  },
  // 真实 CLI 调插件工具：工具返回随机口令，回答里出现它才说明工具真的被调用了。
  "mcp-tools": {
    flags: ["PIGCODE_REAL_CLAUDE", "PIGCODE_REAL_CODEX"],
    description: "real MCP tool call test",
    testFile: "apps/host/src/agents/mcp-tools.real.test.ts",
  },
}

const name = process.argv[2] ?? ""
const target = targets[name]
if (!target) {
  console.error(`usage: node scripts/real-smoke.ts <${Object.keys(targets).join(" | ")}>`)
  process.exit(1)
}

if (!target.flags.some((flag) => process.env[flag] === "1")) {
  console.log(`skip: set ${target.flags.join(" or ")}=1 to run the ${target.description}`)
  process.exit(0)
}

const result = spawnSync(
  "pnpm",
  // vitest 以仓库根目录为 root 读取 vitest.config.ts，文件名也按根目录相对路径匹配。
  ["exec", "vitest", "run", target.testFile],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...target.env },
  },
)
process.exit(result.status ?? 1)
