import { describe, expect, it } from "vitest"
import { resolveCliUpdateSource } from "./cli-update-source"
import { cliUpdateAvailable, cliVersion } from "./cli-update"

describe("CLI update installation source", () => {
  const packageName = "@openai/codex"
  it("updates the actual Bun or npm prefix", () => {
    const bun = resolveCliUpdateSource({
      packageName,
      executable: "/home/me/.bun/bin/codex",
      realExecutable: "/home/me/.bun/install/global/node_modules/@openai/codex/bin/codex.js",
    })
    expect(bun).toMatchObject({ manager: "bun", args: ["add", "--global", "@openai/codex@latest"] })
    const npm = resolveCliUpdateSource({
      packageName,
      executable: "/opt/node-v22/bin/codex",
      realExecutable: "/opt/node-v22/lib/node_modules/@openai/codex/bin/codex.js",
    })
    expect(npm).toMatchObject({
      manager: "npm",
      args: ["install", "--global", "--prefix", "/opt/node-v22", "@openai/codex@latest"],
    })
  })
  it("keeps a pnpm installation in its global directory", () => {
    const source = resolveCliUpdateSource({
      packageName,
      executable: "/home/me/.local/share/pnpm/codex",
      realExecutable:
        "/home/me/.local/share/pnpm/global/5/.pnpm/@openai+codex@1.0.0/node_modules/@openai/codex/bin/codex.js",
    })
    expect(source).toMatchObject({ manager: "pnpm" })
    expect(source?.args).toContain("/home/me/.local/share/pnpm/global/5")
    expect(source?.args).toContain("/home/me/.local/share/pnpm")
  })
  it("keeps Homebrew's cask and release channel", () => {
    const source = resolveCliUpdateSource({
      packageName: "@anthropic-ai/claude-code",
      brewFormula: "claude-code",
      executable: "/opt/homebrew/bin/claude",
      realExecutable: "/opt/homebrew/Caskroom/claude-code@latest/2.1.0/claude",
    })
    expect(source).toMatchObject({
      manager: "brew",
      args: ["upgrade", "--cask", "claude-code@latest"],
      versionFormat: "brew-cask",
    })
  })
  it("does not treat project dependencies or arbitrary custom binaries as global installs", () => {
    expect(
      resolveCliUpdateSource({
        packageName,
        executable: "/work/app/node_modules/.bin/codex",
        realExecutable: "/work/app/node_modules/@openai/codex/bin/codex.js",
      }),
    ).toBeNull()
    expect(
      resolveCliUpdateSource({
        packageName,
        executable: "/work/tools/codex",
        realExecutable: "/work/tools/codex",
      }),
    ).toBeNull()
  })
  it("recognizes an npm Windows shim without changing its prefix", () => {
    const source = resolveCliUpdateSource({
      packageName,
      executable: "C:/Users/Me/AppData/Roaming/npm/codex.cmd",
      realExecutable: "C:/Users/Me/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js",
    })
    expect(source).toMatchObject({ manager: "npm" })
    expect(source?.args).toContain("C:/Users/Me/AppData/Roaming/npm")
  })
})

describe("CLI update version checks", () => {
  it("preserves prerelease versions and does not propose a downgrade", () => {
    expect(cliVersion("codex-cli 0.167.0-alpha.3")).toBe("0.167.0-alpha.3")
    expect(cliVersion("2.1.304 (Claude Code)")).toBe("2.1.304")
    expect(cliUpdateAvailable("0.168.0-alpha.1", "0.167.1")).toBe(false)
    expect(cliUpdateAvailable("0.167.0-alpha.3", "0.167.0")).toBe(true)
    expect(cliUpdateAvailable(null, "0.167.0")).toBe(false)
  })
})
