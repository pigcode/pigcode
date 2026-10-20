/** Playwright 配置：Electron E2E 使用构建产物中的 profile，并在启动前构建应用。 */
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "@playwright/test"

/** frontend 仓库根目录。 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url))

process.env.PIGCODE_E2E = "1"
process.env.PIGCODE_PROFILE_DIR = join(repoRoot, "apps/desktop/out/host/profile")

export default defineConfig({
  testDir: ".",
  testMatch: ["e2e/**/*.spec.ts", "visual/**/*.spec.ts"],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: "line",
  globalSetup: "./e2e/global-setup.ts",
  // 截图基线放在 visual/__screenshots__，不随平台名分裂。
  snapshotPathTemplate: "{testFileDir}/__screenshots__/{arg}{ext}",
})
