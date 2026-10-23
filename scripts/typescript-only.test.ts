/** 仓库只保留 TypeScript 源码：脚本、配置、示例插件与 Host 子进程入口都不再有 JavaScript 文件。 */
import { readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/** frontend 目录。 */
const root = fileURLToPath(new URL("..", import.meta.url))

/** 依赖、构建产物与测试报告不是源码。 */
const SKIPPED_DIRS = new Set([
  "node_modules",
  "out",
  "dist",
  "coverage",
  "test-results",
  "playwright-report",
])

const JAVASCRIPT_FILE = /\.(?:js|mjs|cjs|jsx)$/

/** 递归列出 JavaScript 文件，路径相对 frontend 目录。 */
function javascriptFiles(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...javascriptFiles(path))
    else if (JAVASCRIPT_FILE.test(entry.name)) found.push(relative(root, path))
  }
  return found
}

describe("TypeScript-only sources", () => {
  it("has no JavaScript source files", () => {
    expect(javascriptFiles(root)).toEqual([])
  })
})
