/** 用 fixture 脚本验证检测解析，不依赖真实账号。 */
import { mkdtemp, writeFile, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { detectClaude } from "./detect"

describe("detectClaude", () => {
  // fixture 是 /bin/sh 脚本，Windows 上不能直接执行。
  it.skipIf(process.platform === "win32")("parses version and auth status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-claude-"))
    const bin = join(dir, "claude")
    await writeFile(
      bin,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.304 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"pro"}'; exit 0
fi
exit 1
`,
    )
    await chmod(bin, 0o755)
    const result = await detectClaude({ command: bin })
    expect(result.installed).toBe(true)
    expect(result.version).toContain("2.1.304")
    expect(result.loggedIn).toBe(true)
    expect(result.subscriptionType).toBe("pro")
  })
})
