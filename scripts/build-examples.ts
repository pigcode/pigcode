/** 构建 examples/* 里的插件包。单测和 E2E 都会装上样例，装的是构建后的 dist（adr/0006）。 */
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/** 逐个构建 examples 下的包；没有 package.json 的目录跳过。 */
export function buildExamples(repoRoot = fileURLToPath(new URL("..", import.meta.url))): void {
  const examples = join(repoRoot, "examples")
  for (const name of readdirSync(examples)) {
    const dir = join(examples, name)
    if (!existsSync(join(dir, "package.json"))) continue
    execFileSync(process.execPath, [join(repoRoot, "scripts/build-plugin.ts")], {
      cwd: dir,
      stdio: "ignore",
    })
  }
}

/** vitest 的 globalSetup：整个测试会话开始时构建一次。 */
export default function setup(): void {
  buildExamples()
}
