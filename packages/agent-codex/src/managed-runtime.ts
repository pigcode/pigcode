import { execFile } from "node:child_process"
import { access, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import { downloadRuntime } from "@pigcode/plugin-sdk/runtime-archive"
import {
  settingString,
  type AgentInstanceContext,
  type AgentSettingsValues,
} from "@pigcode/plugin-sdk"
import { findExecutable } from "@pigcode/plugin-sdk/node"
import { codexExecutable } from "./launch"

const exec = promisify(execFile)
export const managedCodexVersion = "0.171.0"
// OpenAI release asset digests from https://github.com/openai/codex/releases/tag/rust-v0.171.0
const targets: Record<string, [string, string]> = {
  "darwin-arm64": [
    "aarch64-apple-darwin",
    "58c88032ec446e72922d911d8f03773102da20c16a6059cf21f6744bce57f210",
  ],
  "darwin-x64": [
    "x86_64-apple-darwin",
    "dd130ea3217b4e6fe4454c99949e0b28e2e8a9ad8da8c3a75f0c7265fab7153b",
  ],
  "linux-arm64": [
    "aarch64-unknown-linux-musl",
    "d8c43bee6cf11b01eb18b95f4d7961092bc40228180808859e70dabb7784c1c9",
  ],
  "linux-x64": [
    "x86_64-unknown-linux-musl",
    "8391d67757496bfd14893eca6cbf0c96994bf2627566ff1f018f70600c9ef6b3",
  ],
  "win32-arm64": [
    "aarch64-pc-windows-msvc",
    "9715d5b310d05b0d878725763362b837857f5eb90fbe4ac57997f5e8656dc178",
  ],
  "win32-x64": [
    "x86_64-pc-windows-msvc",
    "669941eff23dd8470fbf85d919a03d80c4e3d35b441e3fcd361c0f8630945be8",
  ],
}

export interface CodexRelease {
  target: string
  version: string
  url: string
  digest: string
  command: string
}

export function codexRelease(
  platform = process.platform,
  arch = process.arch,
): CodexRelease | null {
  const target = targets[platform + "-" + arch]
  if (!target) return null
  return {
    target: target[0],
    version: managedCodexVersion,
    digest: target[1],
    url: `https://github.com/openai/codex/releases/download/rust-v${managedCodexVersion}/codex-package-${target[0]}.tar.gz`,
    command: platform === "win32" ? "bin/codex.exe" : "bin/codex",
  }
}

async function localCodex(settings: AgentSettingsValues) {
  const name = codexExecutable(settings)
  const explicit = Boolean(settingString(settings, "binaryPath") || process.env.PIGCODE_CODEX_PATH)
  const command = isAbsolute(name) || /[\\/]/.test(name) ? name : findExecutable(name)
  if (command) {
    try {
      await access(command, constants.X_OK)
      return command
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && explicit) throw error
    }
  }
  if (explicit) throw new Error("Configured Codex executable is unavailable: " + name)
  return null
}

async function verifiedLayout(directory: string, release: CodexRelease) {
  const manifestPath = join(directory, "codex-package.json")
  const info = await lstat(manifestPath)
  if (!info.isFile() || info.size > 8192) throw new Error("Invalid Codex package manifest")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  if (
    manifest.layoutVersion !== 1 ||
    manifest.version !== release.version ||
    manifest.target !== release.target ||
    manifest.entrypoint !== release.command
  )
    throw new Error("Codex package did not match the requested release")
  const extension = release.command.endsWith(".exe") ? ".exe" : ""
  for (const file of [
    release.command,
    "bin/codex-code-mode-host" + extension,
    "codex-path/rg" + extension,
  ]) {
    const entry = await lstat(join(directory, file))
    if (!entry.isFile() || !entry.size || (!extension && !(entry.mode & 0o111)))
      throw new Error("Codex package is missing a required executable")
  }
  return join(directory, release.command)
}

interface Installation {
  controller: AbortController
  waiters: number
  done: Promise<string>
}

export class ManagedCodexRuntime {
  private readonly jobs = new Map<string, Installation>()
  constructor(
    private readonly options: {
      release?: CodexRelease | undefined
      fetcher?: typeof fetch
      local?: (settings: AgentSettingsValues) => Promise<string | null>
    } = {},
  ) {}

  local(settings: AgentSettingsValues) {
    return (this.options.local ?? localCodex)(settings)
  }

  /** 没有 signal 时仅查询；只有用户开始登录时才传入允许安装的 signal。 */
  async resolve(
    settings: AgentSettingsValues,
    scope: AgentInstanceContext,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const local = await this.local(settings)
    if (local) return local
    const release = this.options.release ?? codexRelease()
    if (!release) {
      if (signal) throw new Error("OpenAI does not publish a Codex package for this platform")
      return null
    }
    const cache = join(scope.sharedDir, "codex-runtime")
    const final = join(cache, release.version + "-" + release.target)
    const installed = await this.cached(final, release)
    if (installed || !signal) return installed
    signal.throwIfAborted()
    let job = this.jobs.get(final)
    if (!job || job.controller.signal.aborted) {
      const next: Installation = {
        controller: new AbortController(),
        waiters: 0,
        done: Promise.resolve(""),
      }
      next.done = this.install(cache, final, release, next.controller.signal).finally(() => {
        if (this.jobs.get(final) === next) this.jobs.delete(final)
      })
      this.jobs.set(final, next)
      job = next
    }
    job.waiters += 1
    const current = job
    let detach = () => {}
    const cancelled = new Promise<never>((_, reject) => {
      const onAbort = () => reject(signal.reason)
      signal.addEventListener("abort", onAbort, { once: true })
      detach = () => signal.removeEventListener("abort", onAbort)
      if (signal.aborted) onAbort()
    })
    try {
      return await Promise.race([current.done, cancelled])
    } finally {
      detach()
      if (--current.waiters === 0 && signal.aborted) {
        current.controller.abort()
        await current.done.catch(() => undefined)
      }
    }
  }

  private async cached(directory: string, release: CodexRelease) {
    const entry = await lstat(directory).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw error
    })
    if (!entry) return null
    if (!entry.isDirectory()) throw new Error("Invalid Codex runtime directory")
    const marker = join(directory, ".install-complete")
    const info = await lstat(marker)
    if (
      !info.isFile() ||
      info.size !== release.digest.length ||
      (await readFile(marker, "utf8")) !== release.digest
    )
      throw new Error("Installed Codex runtime checksum record differs")
    return verifiedLayout(directory, release)
  }

  private async install(cache: string, final: string, release: CodexRelease, signal: AbortSignal) {
    await mkdir(cache, { recursive: true, mode: 0o700 })
    const stage = await mkdtemp(join(cache, ".install-"))
    try {
      await downloadRuntime(this.options.fetcher ?? fetch, release, stage, { signal })
      const command = await verifiedLayout(stage, release)
      const opts = { signal, timeout: 30_000, windowsHide: true, maxBuffer: 256 * 1024 }
      const output = await exec(command, ["--version"], opts)
      if (output.stdout.trim() !== "codex-cli " + release.version)
        throw new Error("Codex returned an unexpected CLI version")
      await exec(command, ["app-server", "--help"], opts)
      await writeFile(join(stage, ".install-complete"), release.digest, { mode: 0o600, flag: "wx" })
      signal.throwIfAborted()
      try {
        await rename(stage, final)
      } catch (error) {
        const installed = await this.cached(final, release)
        if (installed) return installed
        throw error
      }
      return join(final, release.command)
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }
}
