import { execFile, spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { promisify } from "node:util"
import { mobileRunChangedFile, type MobileRunChangedFile } from "@pigcode/contracts"

const exec = promisify(execFile)
const commandTimeout = 8_000
const patchPageLength = 8 * 1024
const maxStatBytes = 8 * 1024 * 1024
const maxSavedPathBytes = 48 * 1024
const env = { ...process.env, LC_ALL: "C" }
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

export interface CheckpointRange {
  cwd: string
  before: string
  after: string
  gitDir?: string
  prefix?: string
}

export interface CheckpointWorkspace {
  cwd: string
  root: string
  gitDir: string
  prefix: string
}

export async function checkpointWorkspace(cwd: string, signal: AbortSignal): Promise<CheckpointWorkspace> {
  const query = async (field: string) => (await exec("git", ["rev-parse", field], {
    cwd, env, signal, maxBuffer: 16 * 1024,
  })).stdout.replace(/\r?\n$/, "")
  const [root, gitDir, prefix] = await Promise.all([
    query("--show-toplevel"), query("--git-common-dir"), query("--show-prefix"),
  ])
  return { cwd, root: await realpath(root), gitDir: resolve(cwd, gitDir), prefix }
}

export function workspaceRange(workspace: CheckpointWorkspace, before: string, after: string): CheckpointRange {
  return { cwd: workspace.gitDir, gitDir: workspace.gitDir, prefix: workspace.prefix, before, after }
}

function diffArgs(range: CheckpointRange, options: string[], path?: string): string[] {
  if (!objectId.test(range.before) || !objectId.test(range.after)) {
    throw new Error("invalid checkpoint commit")
  }
  return [
    "--literal-pathspecs", ...(range.gitDir ? ["--git-dir", range.gitDir] : []),
    "diff", range.prefix === undefined ? "--relative" : "--relative=" + range.prefix,
    "--no-color", "--no-ext-diff",
    "--no-textconv", "--no-renames", "--submodule=short", ...options,
    range.before, range.after, "--", ...(path === undefined ? [] : [(range.prefix ?? "") + path]),
  ]
}

/** Names remain useful if the repository or checkpoint objects become unavailable. */
export async function readCheckpointPaths(range: CheckpointRange): Promise<string[]> {
  const { stdout } = await exec("git", diffArgs(range, ["--name-only", "-z"]), {
    cwd: range.cwd,
    env,
    maxBuffer: maxStatBytes,
    timeout: 2_000,
  })
  const paths: string[] = []
  let bytes = 2
  for (const path of stdout.split("\0")) {
    if (!path || path.length > 4096) continue
    bytes += Buffer.byteLength(JSON.stringify(path)) + 1
    if (bytes > maxSavedPathBytes) break
    paths.push(path)
  }
  return paths
}

/** Read stats from two saved trees, scoped to the thread's working directory. */
export async function readCheckpointChanges(range: CheckpointRange, path?: string): Promise<MobileRunChangedFile[]> {
  const { stdout } = await exec("git", diffArgs(range, ["--numstat", "-z"], path), {
    cwd: range.cwd,
    env,
    maxBuffer: maxStatBytes,
    timeout: commandTimeout,
  })
  const files: MobileRunChangedFile[] = []
  for (const record of stdout.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record)
    if (!match) continue
    const [, added, removed, filePath] = match
    const result = mobileRunChangedFile.safeParse(added === "-" || removed === "-"
      ? { path: filePath, binary: true }
      : { path: filePath, added: Number(added), removed: Number(removed) })
    if (result.success) files.push(result.data)
  }
  return files
}

/** Stream a single file's immutable diff. Offsets use UTF-16 code units, like Dart strings. */
export async function readCheckpointPatch(range: CheckpointRange, path: string, offset: number) {
  const child = spawn("git", diffArgs(range, ["--patch", "--unified=3"], path), {
    cwd: range.cwd,
    env,
    stdio: ["ignore", "pipe", "ignore"],
    signal: AbortSignal.timeout(commandTimeout),
    windowsHide: true,
  })
  const finished = new Promise<boolean>((resolve) => {
    child.once("error", () => undefined)
    child.once("close", (code) => resolve(code === 0))
  })
  let consumed = 0
  let text = ""
  try {
    for await (const chunk of child.stdout.setEncoding("utf8") as AsyncIterable<string>) {
      const start = Math.max(0, offset - consumed)
      consumed += chunk.length
      if (start >= chunk.length) continue
      if (/^[\uDC00-\uDFFF]$/.test(chunk.charAt(start))) return undefined
      text += chunk.slice(start, start + patchPageLength + 1 - text.length)
      if (text.length > patchPageLength) {
        const limit = /^[\uDC00-\uDFFF]$/.test(text.charAt(patchPageLength))
          ? patchPageLength - 1
          : patchPageLength
        return { text: text.slice(0, limit), nextOffset: offset + limit }
      }
    }
    if (!(await finished)) throw new Error("could not compare checkpoint trees")
    return offset <= consumed ? { text } : undefined
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await finished
  }
}
