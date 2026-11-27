/** `build-host.ts` headless 入口与 `build-headless-host.ts` 独立部署包回归测试。 */
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { buildHeadlessHost, HEADLESS_OUT_DIR } from "./build-headless-host.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const desktopOutHost = join(root, "apps/desktop/out/host")
const headlessBundle = join(desktopOutHost, "headless.mjs")
const repoBin = join(root, "apps/host/bin/pigcode-host.mjs")

const tempDirs: string[] = []

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function runNode(scriptPath: string, args: string[], cwd: string = root): string {
  return execFileSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 20_000,
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("headless host build and deployment bundle", () => {
  beforeAll(async () => {
    await buildHeadlessHost()
  }, 60_000)

  it("builds apps/desktop/out/host/headless.mjs without static electron imports", () => {
    expect(existsSync(headlessBundle)).toBe(true)
    const code = readFileSync(headlessBundle, "utf8")
    // plugin-download.ts 在运行时按 process.versions.electron 守卫动态加载 electron，需忽略该守卫调用。
    const stripped = code.replace(
      /createRequire\(import\.meta\.url\)\(\s*["']electron["']\s*\)/g,
      "",
    )
    expect(stripped).not.toMatch(/\bfrom\s+["']electron["']/)
    expect(stripped).not.toMatch(/\bimport\s+["']electron["']/)
    expect(stripped).not.toMatch(/\bimport\s*\(\s*["']electron["']\s*\)/)
    expect(stripped).not.toMatch(/\brequire\s*\(\s*["']electron["']\s*\)/)
  })

  it("executes out/host/headless.mjs --help directly under pure Node", () => {
    const output = runNode(headlessBundle, ["--help"])
    expect(output).toContain("pigcode-host")
    expect(output).toContain("start")
    expect(output).toContain("pair")
    expect(output).toContain("relay")
    expect(output).toContain("devices")
  })

  it("executes out/host/headless.mjs --dump-config with a profile directory", () => {
    const profileDir = makeTempDir("pigcode-headless-dump-")
    const output = runNode(headlessBundle, ["--profile-dir", profileDir, "--dump-config"])
    const parsed = JSON.parse(output) as { entries?: Array<{ id: string }> }
    expect(Array.isArray(parsed.entries)).toBe(true)
    expect(parsed.entries!.length).toBeGreaterThan(0)
    expect(parsed.entries!.some((entry) => entry.id === "core.storage")).toBe(true)
    expect(parsed.entries!.some((entry) => entry.id === "core.agents")).toBe(true)
  }, 20_000)

  it("executes apps/host/bin/pigcode-host.mjs directly and through a symlink", () => {
    const directOutput = runNode(repoBin, ["--help"])
    expect(directOutput).toContain("start")
    expect(directOutput).toContain("pair")
    expect(directOutput).toContain("relay")
    expect(directOutput).toContain("devices")

    const linkDir = makeTempDir("pigcode-bin-link-")
    const linkPath = join(linkDir, "pigcode-host")
    symlinkSync(repoBin, linkPath)
    const symlinkOutput = runNode(linkPath, ["--help"], linkDir)
    expect(symlinkOutput).toContain("start")
    expect(symlinkOutput).toContain("pair")
    expect(symlinkOutput).toContain("relay")
    expect(symlinkOutput).toContain("devices")
  })

  it("assembles apps/host/out/headless with expected runtime files and manifests", () => {
    expect(existsSync(join(HEADLESS_OUT_DIR, "host/headless.mjs"))).toBe(true)
    expect(existsSync(join(HEADLESS_OUT_DIR, "host/headless.mjs.map"))).toBe(true)
    expect(existsSync(join(HEADLESS_OUT_DIR, "host/core/storage.mjs"))).toBe(true)
    expect(existsSync(join(HEADLESS_OUT_DIR, "host/core/agents.mjs"))).toBe(true)
    expect(existsSync(join(HEADLESS_OUT_DIR, "host/plugins/agent-claude/index.mjs"))).toBe(true)
    expect(existsSync(join(HEADLESS_OUT_DIR, "host/plugins/agent-cursor/index.mjs"))).toBe(true)
    expect(existsSync(join(HEADLESS_OUT_DIR, "host/mcp/stdio-bridge.mjs"))).toBe(true)
    expect(existsSync(join(HEADLESS_OUT_DIR, "host/profile/desktop.yml"))).toBe(true)
    const cursorDir = join(HEADLESS_OUT_DIR, "host/node_modules/@cursor")
    expect(existsSync(cursorDir)).toBe(true)
    expect(readdirSync(cursorDir).length).toBeGreaterThan(0)

    // Electron 专属产物不能打入无窗口部署包。
    expect(existsSync(join(HEADLESS_OUT_DIR, "host/index.mjs"))).toBe(false)
    expect(existsSync(join(HEADLESS_OUT_DIR, "host/index.mjs.map"))).toBe(false)
    expect(existsSync(join(HEADLESS_OUT_DIR, "host/build-id"))).toBe(false)

    const binPath = join(HEADLESS_OUT_DIR, "bin/pigcode-host.mjs")
    expect(existsSync(binPath)).toBe(true)
    if (process.platform !== "win32") {
      expect(statSync(binPath).mode & 0o111).not.toBe(0)
    }

    expect(existsSync(join(HEADLESS_OUT_DIR, "scripts/fix-node-pty-helper.mjs"))).toBe(true)

    const desktopPkg = JSON.parse(
      readFileSync(join(root, "apps/desktop/package.json"), "utf8"),
    ) as {
      version: string
      dependencies: Record<string, string>
    }
    const hostPkg = JSON.parse(readFileSync(join(root, "apps/host/package.json"), "utf8")) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    const headlessPkg = JSON.parse(
      readFileSync(join(HEADLESS_OUT_DIR, "package.json"), "utf8"),
    ) as {
      name: string
      version: string
      private: boolean
      type: string
      engines: Record<string, string>
      bin: Record<string, string>
      scripts: Record<string, string>
      dependencies: Record<string, string>
    }

    expect(headlessPkg.name).toBe("@pigcode/headless-host")
    expect(headlessPkg.version).toBe(desktopPkg.version)
    expect(headlessPkg.private).toBe(true)
    expect(headlessPkg.type).toBe("module")
    expect(headlessPkg.engines.node).toBe(">=22.18")
    expect(headlessPkg.bin["pigcode-host"]).toBe("./bin/pigcode-host.mjs")
    expect(headlessPkg.scripts.postinstall).toBe("node ./scripts/fix-node-pty-helper.mjs")
    expect(headlessPkg.dependencies["better-sqlite3"]).toBe(hostPkg.dependencies["better-sqlite3"])
    expect(headlessPkg.dependencies["node-pty"]).toBe(hostPkg.dependencies["node-pty"])
    expect(headlessPkg.dependencies["esbuild"]).toBe(hostPkg.devDependencies["esbuild"])
    expect(headlessPkg.dependencies["@cursor/sdk"]).toBe(desktopPkg.dependencies["@cursor/sdk"])

    const serviceUnit = readFileSync(
      join(HEADLESS_OUT_DIR, "examples/pigcode-host.service"),
      "utf8",
    )
    expect(serviceUnit).toContain("[Unit]")
    expect(serviceUnit).toContain("After=network-online.target")
    expect(serviceUnit).toContain("[Service]")
    expect(serviceUnit).toContain("ExecStart=%h/.local/share/pigcode-host/bin/pigcode-host")
    expect(serviceUnit).toContain("WorkingDirectory=")
    expect(serviceUnit).toContain("Restart=on-failure")
    expect(serviceUnit).toContain("KillSignal=SIGINT")
    expect(serviceUnit).toContain("PIGCODE_CREDENTIAL_KEY")
    expect(serviceUnit).toContain("[Install]")
    expect(serviceUnit).toContain("WantedBy=default.target")

    const readme = readFileSync(join(HEADLESS_OUT_DIR, "README.md"), "utf8")
    expect(readme).toContain("22.18")
    expect(readme).toContain("npm install --omit=dev")
    expect(readme).toContain("node-pty")
    expect(readme).toContain("pigcode-host relay set")
    expect(readme).toContain("pigcode-host start")
    expect(readme).toContain("pigcode-host pair")
    expect(readme).toContain("pigcode-host devices")
    expect(readme).toContain("pigcode-host revoke")
    expect(readme).toContain("credential.key")
    expect(readme).toContain("PIGCODE_CREDENTIAL_KEY")
    expect(readme).toContain("systemd --user")
  })

  it("executes standalone bin/pigcode-host.mjs inside apps/host/out/headless", () => {
    const standaloneBin = join(HEADLESS_OUT_DIR, "bin/pigcode-host.mjs")
    const helpOutput = runNode(standaloneBin, ["--help"], HEADLESS_OUT_DIR)
    expect(helpOutput).toContain("start")
    expect(helpOutput).toContain("pair")

    const profileDir = makeTempDir("pigcode-standalone-dump-")
    const dumpOutput = runNode(
      standaloneBin,
      ["--profile-dir", profileDir, "--dump-config"],
      HEADLESS_OUT_DIR,
    )
    const parsed = JSON.parse(dumpOutput) as { entries?: Array<{ id: string }> }
    expect(Array.isArray(parsed.entries)).toBe(true)
    expect(parsed.entries!.length).toBeGreaterThan(0)
    expect(parsed.entries!.some((entry) => entry.id === "core.storage")).toBe(true)
  }, 20_000)

  it("fixes node-pty spawn-helper executable permission via postinstall script", () => {
    const sandbox = makeTempDir("pigcode-pty-postinstall-")
    mkdirSync(join(sandbox, "scripts"), { recursive: true })
    mkdirSync(join(sandbox, "node_modules/node-pty/prebuilds/darwin-arm64"), { recursive: true })
    writeFileSync(join(sandbox, "package.json"), JSON.stringify({ name: "test", type: "module" }))
    writeFileSync(
      join(sandbox, "node_modules/node-pty/package.json"),
      JSON.stringify({ name: "node-pty", version: "1.1.0" }),
    )
    const helperPath = join(sandbox, "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper")
    writeFileSync(helperPath, "#!/bin/sh\n")
    chmodSync(helperPath, 0o644)

    const scriptTarget = join(sandbox, "scripts/fix-node-pty-helper.mjs")
    copyFileSync(join(HEADLESS_OUT_DIR, "scripts/fix-node-pty-helper.mjs"), scriptTarget)
    runNode(scriptTarget, [], sandbox)

    if (process.platform !== "win32") {
      expect(statSync(helperPath).mode & 0o111).not.toBe(0)
    }
  })
})
