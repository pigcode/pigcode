import type { AgentAuthState } from "@pigcode/contracts"
import type { AgentLoginPty } from "@pigcode/plugin-sdk"

export interface Login {
  state: AgentAuthState
  controller: AbortController
  done: Promise<void>
  pty?: AgentLoginPty
}

export function signingIn(login?: Login): boolean {
  const phase = login?.state.phase
  return phase === "starting" || phase === "waiting" || phase === "verifying"
}

/** 仅在当前登录期间保留有限的 PTY 输出，让晚挂载的 xterm 能显示第一个提示符。 */
export async function runTerminalLogin(login: Login, pty: AgentLoginPty, signal: AbortSignal) {
  login.pty = pty
  login.state = { ...login.state, phase: "waiting", terminal: { output: "", offset: 0 } }
  let exited = false
  let abort: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      pty.onData((data) => {
        const previous = login.state.terminal
        if (!previous) return
        login.state.terminal = {
          output: (previous.output + data).slice(-32_768),
          offset: previous.offset + data.length,
        }
      })
      pty.onExit(({ exitCode, signal: killed }) => {
        exited = true
        if (exitCode === 0 && !killed) resolve()
        else reject(new Error("The ACP sign-in command exited before completing sign-in"))
      })
      if (signal.aborted) abort()
    })
  } finally {
    if (abort) signal.removeEventListener("abort", abort)
    delete login.pty
    delete login.state.terminal
    if (!exited) await pty.kill()
  }
}
