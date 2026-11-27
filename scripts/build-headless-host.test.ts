/** `build-host.ts` 入口隔离与 `build-headless-host.ts` 独立部署包回归测试。 */
import { execFileSync, spawn } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { callAdminSocket } from "../apps/host/src/kernel/admin-socket.ts"
import { buildHeadlessHost } from "./build-headless-host.ts"
import { buildHost } from "./build-host.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const repoBinTs = join(root, "apps/host/bin/pigcode-host.ts")

const tempDirs: string[] = []
let testOutDir = ""

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

function tryCreateFileSymlink(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath)
    return true
  } catch (error) {
    if (
      process.platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "EPERM"
    ) {
      return false
    }
    throw error
  }
}

function createDirLink(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir")
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

afterAll(() => {
  if (testOutDir) rmSync(testOutDir, { recursive: true, force: true })
})

describe("headless host build and deployment bundle", () => {
  beforeAll(async () => {
    testOutDir = mkdtempSync(join(tmpdir(), "pigcode-headless-out-"))
    await buildHeadlessHost({ outDir: testOutDir })
  }, 60_000)

  it("isolates desktop default buildHost() output from headless.mjs", async () => {
    const desktopOut = makeTempDir("pigcode-desktop-host-only-")
    await buildHost({ outDir: desktopOut })
    expect(existsSync(join(desktopOut, "index.mjs"))).toBe(true)
    expect(existsSync(join(desktopOut, "headless.mjs"))).toBe(false)
    expect(existsSync(join(desktopOut, "node_modules"))).toBe(false)
  }, 60_000)

  it("builds host/headless.mjs without static electron imports", () => {
    const bundle = join(testOutDir, "host/headless.mjs")
    expect(existsSync(bundle)).toBe(true)
    const code = readFileSync(bundle, "utf8")
    // plugin-download.ts 在运行时按 process.versions.electron 守卫动态加载 electron，兼容 esbuild 重命名后的 createRequireN。
    const stripped = code.replace(
      /createRequire\d*\(import\.meta\.url\)\(\s*["']electron["']\s*\)/g,
      "",
    )
    expect(stripped).not.toMatch(/\bfrom\s+["']electron["']/)
    expect(stripped).not.toMatch(/\bimport\s+["']electron["']/)
    expect(stripped).not.toMatch(/\bimport\s*\(\s*["']electron["']\s*\)/)
    expect(stripped).not.toMatch(/\brequire\s*\(\s*["']electron["']\s*\)/)
  })

  it("executes host/headless.mjs --help and --dump-config directly under pure Node", () => {
    const bundle = join(testOutDir, "host/headless.mjs")
    const helpOutput = runNode(bundle, ["--help"])
    expect(helpOutput).toContain("pigcode-host")
    expect(helpOutput).toContain("start")
    expect(helpOutput).toContain("pair")
    expect(helpOutput).toContain("relay")
    expect(helpOutput).toContain("devices")

    const profileDir = makeTempDir("pigcode-headless-dump-")
    const dumpOutput = runNode(bundle, ["--profile-dir", profileDir, "--dump-config"])
    const parsed = JSON.parse(dumpOutput) as { entries?: Array<{ id: string }> }
    expect(Array.isArray(parsed.entries)).toBe(true)
    expect(parsed.entries!.length).toBeGreaterThan(0)
    expect(parsed.entries!.some((entry) => entry.id === "core.storage")).toBe(true)
    expect(parsed.entries!.some((entry) => entry.id === "core.agents")).toBe(true)
  }, 20_000)

  it("executes apps/host/bin/pigcode-host.ts directly and through a symlink", () => {
    const fixture = makeTempDir("pigcode-ts-bin-fixture-")
    const fixtureBinDir = join(fixture, "bin")
    mkdirSync(fixtureBinDir, { recursive: true })
    const copiedTsBin = join(fixtureBinDir, "pigcode-host.ts")
    copyFileSync(repoBinTs, copiedTsBin)
    createDirLink(join(testOutDir, "host"), join(fixture, "host"))

    const directOutput = runNode(copiedTsBin, ["--help"], fixture)
    expect(directOutput).toContain("start")
    expect(directOutput).toContain("pair")
    expect(directOutput).toContain("relay")
    expect(directOutput).toContain("devices")

    const linkDir = makeTempDir("pigcode-ts-bin-link-")
    const linkPath = join(linkDir, "pigcode-host")
    if (tryCreateFileSymlink(copiedTsBin, linkPath)) {
      const symlinkOutput = runNode(linkPath, ["--help"], linkDir)
      expect(symlinkOutput).toContain("start")
      expect(symlinkOutput).toContain("pair")
    }
  })

  it("assembles headless deployment package without Electron artifacts or build-machine native deps", () => {
    expect(existsSync(join(testOutDir, "host/headless.mjs"))).toBe(true)
    expect(existsSync(join(testOutDir, "host/headless.mjs.map"))).toBe(true)
    expect(existsSync(join(testOutDir, "host/core/storage.mjs"))).toBe(true)
    expect(existsSync(join(testOutDir, "host/core/agents.mjs"))).toBe(true)
    expect(existsSync(join(testOutDir, "host/plugins/agent-claude/index.mjs"))).toBe(true)
    expect(existsSync(join(testOutDir, "host/plugins/agent-cursor/index.mjs"))).toBe(true)
    expect(existsSync(join(testOutDir, "host/mcp/stdio-bridge.mjs"))).toBe(true)
    expect(existsSync(join(testOutDir, "host/profile/desktop.yml"))).toBe(true)

    // Electron 专属产物与构建机本机 node_modules 不能带入跨平台部署包。
    expect(existsSync(join(testOutDir, "host/index.mjs"))).toBe(false)
    expect(existsSync(join(testOutDir, "host/index.mjs.map"))).toBe(false)
    expect(existsSync(join(testOutDir, "host/build-id"))).toBe(false)
    expect(existsSync(join(testOutDir, "host/node_modules"))).toBe(false)

    expect(existsSync(join(testOutDir, "bin/pigcode.mjs"))).toBe(true)
    const binPath = join(testOutDir, "bin/pigcode-host.mjs")
    expect(existsSync(binPath)).toBe(true)
    const binSource = readFileSync(binPath, "utf8")
    expect(binSource.startsWith("#!/usr/bin/env node")).toBe(true)
    expect(binSource).toContain("process.argv[1] =")
    if (process.platform !== "win32") {
      expect(statSync(binPath).mode & 0o111).not.toBe(0)
      expect(statSync(join(testOutDir, "bin/pigcode.mjs")).mode & 0o111).not.toBe(0)
    }

    expect(existsSync(join(testOutDir, "scripts/fix-node-pty-helper.mjs"))).toBe(true)

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
    const headlessPkg = JSON.parse(readFileSync(join(testOutDir, "package.json"), "utf8")) as {
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
    expect(headlessPkg.bin["pigcode"]).toBe("./bin/pigcode.mjs")
    expect(headlessPkg.bin["pigcode-host"]).toBe("./bin/pigcode-host.mjs")
    expect(headlessPkg.scripts.postinstall).toBe("node ./scripts/fix-node-pty-helper.mjs")
    expect(headlessPkg.dependencies["better-sqlite3"]).toBe(hostPkg.dependencies["better-sqlite3"])
    expect(headlessPkg.dependencies["node-pty"]).toBe(hostPkg.dependencies["node-pty"])
    expect(headlessPkg.dependencies["esbuild"]).toBe(hostPkg.devDependencies["esbuild"])
    expect(headlessPkg.dependencies["@cursor/sdk"]).toBe(desktopPkg.dependencies["@cursor/sdk"])

    const serviceUnit = readFileSync(join(testOutDir, "examples/pigcode.service"), "utf8")
    expect(serviceUnit).toContain("[Unit]")
    expect(serviceUnit).toContain("After=network-online.target")
    expect(serviceUnit).toContain("[Service]")
    expect(serviceUnit).toContain("ExecStart=%h/.local/share/pigcode/bin/pigcode")
    expect(serviceUnit).toContain("WorkingDirectory=")
    expect(serviceUnit).toContain("Restart=on-failure")
    expect(serviceUnit).toContain("KillSignal=SIGINT")
    expect(serviceUnit).toContain("PIGCODE_CREDENTIAL_KEY")
    expect(serviceUnit).toContain("[Install]")
    expect(serviceUnit).toContain("WantedBy=default.target")
    expect(existsSync(join(testOutDir, "examples/pigcode-host.service"))).toBe(true)

    const readme = readFileSync(join(testOutDir, "README.md"), "utf8")
    expect(readme).toContain("22.18")
    expect(readme).toContain("npm install --omit=dev")
    expect(readme).toContain("node-pty")
    expect(readme).toContain("pigcode relay set")
    expect(readme).toContain("pigcode start")
    expect(readme).toContain("pigcode pair --desktop")
    expect(readme).toContain("pigcode devices")
    expect(readme).toContain("pigcode revoke")
    expect(readme).toContain("credential.key")
    expect(readme).toContain("PIGCODE_CREDENTIAL_KEY")
    expect(readme).toContain("systemd --user")
  })

  it("boots standalone bin/pigcode-host.mjs in an isolated runtime directory and stops cleanly", async () => {
    const isolated = makeTempDir("pigcode-headless-isolated-")
    cpSync(join(testOutDir, "host"), join(isolated, "host"), { recursive: true })
    cpSync(join(testOutDir, "bin"), join(isolated, "bin"), { recursive: true })
    copyFileSync(join(testOutDir, "package.json"), join(isolated, "package.json"))

    const hostRequire = createRequire(join(root, "apps/host/package.json"))
    const desktopRequire = createRequire(join(root, "apps/desktop/package.json"))
    const nodeModules = join(isolated, "node_modules")
    mkdirSync(join(nodeModules, "@cursor"), { recursive: true })
    createDirLink(
      dirname(hostRequire.resolve("better-sqlite3/package.json")),
      join(nodeModules, "better-sqlite3"),
    )
    createDirLink(
      dirname(hostRequire.resolve("node-pty/package.json")),
      join(nodeModules, "node-pty"),
    )
    createDirLink(
      dirname(hostRequire.resolve("esbuild/package.json")),
      join(nodeModules, "esbuild"),
    )
    createDirLink(
      resolve(dirname(desktopRequire.resolve("@cursor/sdk")), "..", ".."),
      join(nodeModules, "@cursor/sdk"),
    )

    const standaloneBin = join(isolated, "bin/pigcode-host.mjs")
    const linkDir = makeTempDir("pigcode-standalone-link-")
    const symlinkBin = join(linkDir, "pigcode-host")
    const invokeTarget = tryCreateFileSymlink(standaloneBin, symlinkBin)
      ? symlinkBin
      : standaloneBin

    const profileDir = makeTempDir("pigcode-isolated-profile-")
    const dumpOutput = runNode(
      invokeTarget,
      ["--profile-dir", profileDir, "--dump-config"],
      isolated,
    )
    const parsedDump = JSON.parse(dumpOutput) as { entries?: Array<{ id: string }> }
    expect(Array.isArray(parsedDump.entries)).toBe(true)
    expect(parsedDump.entries!.some((entry) => entry.id === "core.storage")).toBe(true)

    const child = spawn(
      process.execPath,
      [
        invokeTarget,
        "--profile-dir",
        profileDir,
        "start",
        "--lan-port",
        "off",
        "--no-shell-env",
        "--json",
      ],
      {
        cwd: isolated,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )

    try {
      let stdoutBuf = ""
      let stderrBuf = ""
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk: string) => {
        stderrBuf += chunk
      })

      const started = await new Promise<{
        event: string
        runtime: string
        profileDir: string
        socketPath: string
      }>((resolveStart, rejectStart) => {
        const timer = setTimeout(() => {
          rejectStart(new Error(`Host start timed out. stdout=${stdoutBuf} stderr=${stderrBuf}`))
        }, 15_000)

        child.stdout.on("data", (chunk: string) => {
          stdoutBuf += chunk
          for (const line of stdoutBuf.split("\n")) {
            const trimmed = line.trim()
            if (!trimmed.startsWith("{")) continue
            try {
              const payload = JSON.parse(trimmed) as {
                event?: string
                runtime?: string
                profileDir?: string
                socketPath?: string
              }
              if (payload.event === "started" && payload.socketPath) {
                clearTimeout(timer)
                resolveStart(
                  payload as {
                    event: string
                    runtime: string
                    profileDir: string
                    socketPath: string
                  },
                )
                return
              }
            } catch {
              // 继续等待完整 JSON 行
            }
          }
        })

        child.once("exit", (code) => {
          clearTimeout(timer)
          rejectStart(
            new Error(`Host exited early (${code}). stdout=${stdoutBuf} stderr=${stderrBuf}`),
          )
        })
      })

      expect(started.runtime).toBe("headless")
      expect(existsSync(join(profileDir, "pigcode.db"))).toBe(true)
      expect(existsSync(join(profileDir, "boot.json"))).toBe(true)
      expect(existsSync(join(profileDir, "host.lock"))).toBe(true)

      const exitPromise = new Promise<number | null>((resolveExit, rejectExit) => {
        const timer = setTimeout(() => {
          rejectExit(new Error(`Host stop timed out. stderr=${stderrBuf}`))
        }, 10_000)
        child.once("exit", (code) => {
          clearTimeout(timer)
          resolveExit(code)
        })
      })

      if (process.platform === "win32") {
        await callAdminSocket(started.socketPath, "host.stop", { reason: "exited" })
      } else {
        child.kill("SIGINT")
      }
      expect(await exitPromise).toBe(0)
      expect(existsSync(join(profileDir, "host.lock"))).toBe(false)
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL")
    }
  }, 30_000)

  it("hardens fix-node-pty-helper.mjs for prebuilds, symlinked dirs, Release helper, and missing node-pty", () => {
    const sandbox = makeTempDir("pigcode-pty-postinstall-")
    mkdirSync(join(sandbox, "scripts"), { recursive: true })
    writeFileSync(join(sandbox, "package.json"), JSON.stringify({ name: "test", type: "module" }))
    const scriptTarget = join(sandbox, "scripts/fix-node-pty-helper.mjs")
    copyFileSync(join(testOutDir, "scripts/fix-node-pty-helper.mjs"), scriptTarget)

    // 1. node-pty 尚未安装时静默退出 0。
    expect(() => runNode(scriptTarget, [], sandbox)).not.toThrow()

    // 2. 涵盖 prebuilds/<arch>/spawn-helper、符号链接架构目录、build/Release/spawn-helper 与已可执行文件。
    const nodePtyDir = join(sandbox, "node_modules/node-pty")
    const prebuildDir = join(nodePtyDir, "prebuilds/darwin-arm64")
    const externalArchDir = makeTempDir("pigcode-pty-symlink-arch-")
    const releaseDir = join(nodePtyDir, "build/Release")
    mkdirSync(prebuildDir, { recursive: true })
    mkdirSync(releaseDir, { recursive: true })
    writeFileSync(
      join(nodePtyDir, "package.json"),
      JSON.stringify({ name: "node-pty", version: "1.1.0" }),
    )

    const prebuildHelper = join(prebuildDir, "spawn-helper")
    const releaseHelper = join(releaseDir, "spawn-helper")
    const symlinkedHelper = join(externalArchDir, "spawn-helper")
    writeFileSync(prebuildHelper, "#!/bin/sh\n")
    writeFileSync(releaseHelper, "#!/bin/sh\n")
    writeFileSync(symlinkedHelper, "#!/bin/sh\n")
    chmodSync(prebuildHelper, 0o755)
    chmodSync(releaseHelper, 0o644)
    chmodSync(symlinkedHelper, 0o644)
    createDirLink(externalArchDir, join(nodePtyDir, "prebuilds/linux-x64"))

    runNode(scriptTarget, [], sandbox)

    if (process.platform !== "win32") {
      expect(statSync(prebuildHelper).mode & 0o111).not.toBe(0)
      expect(statSync(releaseHelper).mode & 0o111).not.toBe(0)
      expect(statSync(symlinkedHelper).mode & 0o111).not.toBe(0)
    }
  })
})
