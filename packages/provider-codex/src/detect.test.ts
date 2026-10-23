/** 用 fixture 脚本验证 Codex 检测，不依赖真实账号。 */
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { detectCodex } from "./detect"

describe("detectCodex", () => {
  it("parses version and login status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pigcode-codex-"))
    const bin = join(dir, "codex")
    await writeFile(
      bin,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex-cli 0.163.0"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
exit 1
`,
    )
    await chmod(bin, 0o755)
    const result = await detectCodex({ command: bin })
    expect(result.installed).toBe(true)
    expect(result.version).toContain("0.163.0")
    expect(result.loggedIn).toBe(true)
  })
})
