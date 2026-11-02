import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "scripts/**/*.test.ts",
    ],
    environment: "node",
    // Windows runner 上起一次 git 子进程就要几百毫秒，跑真实 git 的用例（工作树、检查点）会超过默认的 5 秒；
    // 只放宽 Windows，别的平台仍然用 5 秒尽早发现变慢的用例。
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    // 其余 CSS 在测试里照旧当空模块；`?raw` 导入（主进程读 tokens.css 原文）要拿到真实文本。
    css: { include: [/\.css\?raw$/] },
    setupFiles: ["./vitest.setup.ts"],
  },
})
