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
    // 其余 CSS 在测试里照旧当空模块；`?raw` 导入（主进程读 tokens.css 原文）要拿到真实文本。
    css: { include: [/\.css\?raw$/] },
    setupFiles: ["./vitest.setup.ts"],
  },
})
