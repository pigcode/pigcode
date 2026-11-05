/** 用假的 shell 脚本验证读取登录 shell 环境：真的启动进程，和应用里一样。 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { mergeShellEnv, needsLoginShellEnv, readLoginShellEnv } from "./shell-env"

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pigcode-shell-env-"))
  dirs.push(dir)
  return dir
}

/** 写一个可执行的假 shell：先跑 body，再执行 -c 后面的命令。 */
function fakeShell(body: string): string {
  const path = join(tempDir(), "fake-shell")
  writeFileSync(path, `#!/bin/sh\n${body}\neval "$4"\n`)
  chmodSync(path, 0o755)
  return path
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === "win32")("login shell environment", () => {
  it("reads what the rc files set, whatever else they print", async () => {
    const shell = fakeShell(`echo welcome back
export PATH="/opt/fake/bin:$PATH"
export LONG_VALUE="line one
line two"`)
    const env = await readLoginShellEnv(shell)
    expect(env?.PATH).toMatch(/^\/opt\/fake\/bin:/)
    expect(env?.LONG_VALUE).toBe("line one\nline two")
  })

  it("gives up when the shell fails, prints nothing useful or doesn't exist", async () => {
    expect(await readLoginShellEnv(fakeShell("exit 1"))).toBeNull()
    expect(await readLoginShellEnv(fakeShell("echo no env; exit 0"))).toBeNull()
    expect(await readLoginShellEnv("/nonexistent/shell")).toBeNull()
  })

  it("doesn't fall over on a path that makes spawn throw", async () => {
    expect(await readLoginShellEnv(join(fakeShell(""), "not-a-directory"))).toBeNull()
  })

  it("stops waiting for a shell that hangs, and ends it", async () => {
    const pidFile = join(tempDir(), "pid")
    const shell = fakeShell(`echo $$ > "${pidFile}"\nsleep 30`)
    // 超时给得比 shell 启动久：机器忙的时候 400ms 可能还没轮到它写 pid。
    expect(await readLoginShellEnv(shell, 1500)).toBeNull()
    // 机器太忙时可能在写 pid 之前就被结束了；那种情况下没有进程留下，也就没什么可等的。
    if (!existsSync(pidFile)) return
    const pid = Number(readFileSync(pidFile, "utf8"))
    await expect.poll(() => isRunning(pid), { timeout: 3000 }).toBe(false)
  })

  // rc 文件里的后台进程一直占着 stdout，不能等到输出关闭。
  it("doesn't wait for a background process the rc files started", async () => {
    const pidFile = join(tempDir(), "pid")
    const shell = fakeShell(`sleep 20 &\necho $! > "${pidFile}"\nexport FROM_RC=yes`)
    const started = Date.now()
    const env = await readLoginShellEnv(shell, 4000)
    const pid = Number(readFileSync(pidFile, "utf8"))
    expect(env?.FROM_RC).toBe("yes")
    expect(Date.now() - started).toBeLessThan(3000)
    // 读到环境就算成功，用户的后台进程不归我们结束。
    expect(isRunning(pid)).toBe(true)
    process.kill(pid)
  })

  it("still works when the rc files export NODE_OPTIONS", async () => {
    const shell = fakeShell("export NODE_OPTIONS=--not-a-real-option")
    expect((await readLoginShellEnv(shell))?.NODE_OPTIONS).toBe("--not-a-real-option")
  })
})

describe("using the login shell environment", () => {
  it("is only needed for a GUI launch outside Windows", () => {
    expect(needsLoginShellEnv({}, "darwin")).toBe(true)
    expect(needsLoginShellEnv({}, "linux")).toBe(true)
    expect(needsLoginShellEnv({ TERM: "linux" }, "linux")).toBe(true)
    expect(needsLoginShellEnv({ TERM: "xterm" }, "darwin")).toBe(false)
    expect(needsLoginShellEnv({}, "win32")).toBe(false)
  })

  it("leaves out that shell's own variables and what the app decides for itself", () => {
    const target: NodeJS.ProcessEnv = { HOME: "/old", PIGCODE_PROFILE_DIR: "/mine" }
    mergeShellEnv(target, {
      HOME: "/new",
      PATH: "/bin",
      API_KEY: "kept",
      DYLD_LIBRARY_PATH: "/x",
      ELECTRON_RUN_AS_NODE: "1",
      LD_LIBRARY_PATH: "/x",
      NODE_OPTIONS: "--bad",
      PIGCODE_DB_PATH: ":memory:",
      PIGCODE_PROFILE_DIR: "/shell",
      SHLVL: "2",
    })
    expect(target).toEqual({
      HOME: "/new",
      PATH: "/bin",
      API_KEY: "kept",
      PIGCODE_PROFILE_DIR: "/mine",
    })
  })
})
