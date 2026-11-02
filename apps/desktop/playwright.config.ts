/** Playwright 配置：Electron E2E 使用构建产物中的 profile，并在启动前构建应用。 */
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"

/** frontend 仓库根目录。 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

process.env.PIGCODE_E2E = "1"
// 用户 profile（安装的插件、设置）放在构建产物之外，globalSetup 每次清空；
// 数据库留在内存里，每次启动都是干净的项目与会话。
process.env.PIGCODE_PROFILE_DIR = join(repoRoot, "apps/desktop/out-e2e/profile")
process.env.PIGCODE_DB_PATH = ":memory:"

/** 真实 Agent 需要等待模型响应，超时单独放宽；其余 E2E 保持原有上限。 */
const realAgent = process.env.PIGCODE_REAL_CLAUDE === "1" || process.env.PIGCODE_REAL_CODEX === "1"

export default defineConfig({
  testDir: ".",
  testMatch: ["e2e/**/*.spec.ts", "visual/**/*.spec.ts"],
  timeout: realAgent ? 180_000 : 60_000,
  expect: { timeout: realAgent ? 120_000 : 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  globalSetup: "./e2e/global-setup.ts",
  // 截图基线放在 visual/__screenshots__，不随平台名分裂。
  snapshotPathTemplate: "{testFileDir}/__screenshots__/{arg}{ext}",
})
