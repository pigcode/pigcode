/** `pigcode-host pair` 子命令：终端二维码展示、轮询核对码、中止竞态保护与 SIGINT 取消。 */
import QRCode from "qrcode"
import { callAdminSocket } from "./admin-socket"
import {
  formatPairingError,
  promptLineDefault,
  type ReadableInputLike,
  type SignalSource,
  type WritableStreamLike,
} from "./headless-cli-format"
import { probeLiveHost } from "./host-lock"

export type ConfirmPromptFn = (options: {
  prompt: string
  signal: AbortSignal
  candidate?: { name: string; code: string; mode: "pair" | "update" }
}) => Promise<string | null>

export interface PairCommandDeps {
  profileDir: string
  showRaw: boolean
  desktop?: boolean | undefined
  json: boolean
  stdout: WritableStreamLike
  stderr: WritableStreamLike
  stdin: ReadableInputLike
  signalSource: SignalSource
  pollIntervalMs: number
  confirmPrompt?: ConfirmPromptFn | undefined
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolveSleep) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolveSleep()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolveSleep()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}

const ADMIN_POLL_TIMEOUT_MS = 2_000

async function cancelAttemptBestEffort(
  socketPath: string,
  id: string,
  desktop: boolean,
): Promise<void> {
  await callAdminSocket(
    socketPath,
    desktop ? "desktop.pairing.cancel" : "mobile.pairing.cancel",
    { id },
    ADMIN_POLL_TIMEOUT_MS,
  ).catch(() => undefined)
}

function emitPairingFailure(
  json: boolean,
  stdout: WritableStreamLike,
  stderr: WritableStreamLike,
  code: string,
  message: string,
): void {
  if (json) {
    stdout.write(`${JSON.stringify({ event: "error", code, message })}\n`)
  } else {
    stderr.write(`${message}\n`)
  }
}

async function awaitConfirmationWithSignal(
  prompt: string,
  candidate: { name: string; code: string; mode: "pair" | "update" },
  signal: AbortSignal,
  deps: PairCommandDeps,
): Promise<string | null> {
  const promptPromise = (
    deps.confirmPrompt
      ? deps.confirmPrompt({ prompt, signal, candidate })
      : promptLineDefault(deps.json ? "" : prompt, deps.stdin, deps.stdout, signal)
  ).catch(() => null)

  if (signal.aborted) return null
  const abortPromise = new Promise<null>((resolveAbort) => {
    signal.addEventListener("abort", () => resolveAbort(null), { once: true })
  })
  return Promise.race([promptPromise, abortPromise])
}

/** 执行 `pigcode pair`（默认手机扫码；传 `desktop: true` 则生成桌面端连接口令）。 */
export async function runPairCommand(deps: PairCommandDeps): Promise<number> {
  const {
    profileDir,
    showRaw,
    desktop = false,
    json,
    stdout,
    stderr,
    signalSource,
    pollIntervalMs,
  } = deps
  const meta = await probeLiveHost(profileDir)
  if (!meta) {
    emitPairingFailure(
      json,
      stdout,
      stderr,
      "host_not_running",
      "Pigcode Host 未运行，请先执行 pigcode start 启动常驻服务。",
    )
    return 1
  }

  let attemptId: string
  let expiresAt: number
  let payloadString: string
  let lanAddresses: string[] = []

  if (desktop) {
    let startView
    try {
      startView = await callAdminSocket(meta.socketPath, "desktop.pairing.start", {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emitPairingFailure(json, stdout, stderr, "admin_error", `启动桌面端配对失败: ${message}`)
      return 1
    }
    if (startView.status !== "waiting" || !startView.attempt?.link) {
      emitPairingFailure(
        json,
        stdout,
        stderr,
        startView.status,
        formatPairingError(startView.status),
      )
      return 1
    }
    attemptId = startView.attempt.id
    expiresAt = startView.attempt.expiresAt
    payloadString = startView.attempt.link
    lanAddresses = startView.attempt.lanAddresses
    if (json) {
      stdout.write(
        `${JSON.stringify({
          event: "waiting",
          role: "desktop",
          attemptId,
          expiresAt,
          link: payloadString,
          lanAddresses,
        })}\n`,
      )
    } else {
      stdout.write(
        "请在另一台 Pigcode 桌面端的「设置 -> 🌐 远程主机 -> ＋ 添加远程主机」中粘贴以下口令（按 Ctrl+C 取消）：\n\n",
      )
      stdout.write(`${payloadString}\n\n`)
      stdout.write(`有效期至: ${new Date(expiresAt).toLocaleTimeString()}\n`)
      if (lanAddresses.length > 0) {
        stdout.write(`包含局域网直连候选: ${lanAddresses.join(", ")}\n`)
      }
      if (showRaw) {
        stdout.write(`说明: 同网段优先走局域网 Noise 直连，跨网段自动经中继穿透。\n`)
      }
    }
  } else {
    let startView
    try {
      startView = await callAdminSocket(meta.socketPath, "mobile.pairing.start", {})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emitPairingFailure(json, stdout, stderr, "admin_error", `启动配对失败: ${message}`)
      return 1
    }
    if (startView.status !== "waiting" || !startView.attempt?.qr) {
      emitPairingFailure(
        json,
        stdout,
        stderr,
        startView.status,
        formatPairingError(startView.status),
      )
      return 1
    }
    attemptId = startView.attempt.id
    expiresAt = startView.attempt.expiresAt
    payloadString = startView.attempt.qr
    if (json) {
      stdout.write(
        `${JSON.stringify({
          event: "waiting",
          attemptId,
          expiresAt,
          qr: payloadString,
        })}\n`,
      )
    } else {
      let qrTerminal: string
      try {
        qrTerminal = await QRCode.toString(payloadString, {
          type: "terminal",
          small: true,
          errorCorrectionLevel: "L",
        })
      } catch (error) {
        await cancelAttemptBestEffort(meta.socketPath, attemptId, false)
        const message = error instanceof Error ? error.message : String(error)
        emitPairingFailure(json, stdout, stderr, "qr-unavailable", `生成终端二维码失败: ${message}`)
        return 1
      }
      stdout.write("请使用 Pigcode 手机端扫描以下二维码（按 Ctrl+C 取消）：\n")
      stdout.write(qrTerminal)
      if (!qrTerminal.endsWith("\n")) stdout.write("\n")
      stdout.write(`有效期至: ${new Date(expiresAt).toLocaleTimeString()}\n`)
      stdout.write("提示: 如需连接到另一台电脑的 Pigcode 桌面端，请改用 pigcode pair --desktop\n")
      if (showRaw) {
        stdout.write(`原始配对数据: ${payloadString}\n`)
      }
    }
  }

  let interrupted = false
  const waitAbort = new AbortController()
  let confirmAbort: AbortController | undefined
  const onSigInt = (): void => {
    if (interrupted) return
    interrupted = true
    waitAbort.abort()
    confirmAbort?.abort()
  }
  signalSource.on("SIGINT", onSigInt)

  const cancelAndExitInterrupted = async (): Promise<number> => {
    await cancelAttemptBestEffort(meta.socketPath, attemptId, desktop)
    emitPairingFailure(json, stdout, stderr, "cancelled", "已取消配对。")
    return 130
  }

  const pollCandidate = async () => {
    const view = desktop
      ? await callAdminSocket(meta.socketPath, "desktop.pairing.view", {}, ADMIN_POLL_TIMEOUT_MS)
      : await callAdminSocket(meta.socketPath, "mobile.pairing.view", {}, ADMIN_POLL_TIMEOUT_MS)
    return {
      status: view.status,
      attempt: view.attempt
        ? {
            id: view.attempt.id,
            candidate: view.attempt.candidate
              ? {
                  confirmation: view.attempt.candidate.confirmation,
                  code: view.attempt.candidate.code,
                  name: view.attempt.candidate.name,
                  mode:
                    "mode" in view.attempt.candidate
                      ? view.attempt.candidate.mode
                      : ("pair" as const),
                }
              : null,
          }
        : null,
    }
  }

  try {
    while (!interrupted) {
      await sleepAbortable(pollIntervalMs, waitAbort.signal)
      if (interrupted) return await cancelAndExitInterrupted()

      let view
      try {
        view = await pollCandidate()
      } catch {
        emitPairingFailure(
          json,
          stdout,
          stderr,
          "host-unavailable",
          formatPairingError("host-unavailable"),
        )
        return 1
      }

      if (interrupted) return await cancelAndExitInterrupted()

      if (view.attempt?.id && view.attempt.id !== attemptId) {
        emitPairingFailure(json, stdout, stderr, "superseded", formatPairingError("superseded"))
        return 1
      }
      if (!view.attempt) {
        const reason = view.status === "waiting" ? "cancelled" : view.status
        emitPairingFailure(json, stdout, stderr, reason, formatPairingError(reason))
        return 1
      }

      if (view.status === "waiting") continue

      if (view.status === "verify" && view.attempt.candidate) {
        const candidate = view.attempt.candidate
        if (json) {
          stdout.write(
            `${JSON.stringify({
              event: "verify",
              role: desktop ? "desktop" : "mobile",
              attemptId,
              code: candidate.code,
              name: candidate.name,
              mode: candidate.mode,
            })}\n`,
          )
        } else {
          stdout.write(
            [
              "",
              `收到${desktop ? "桌面端" : "手机端"}配对请求: ${candidate.name}`,
              `请求类型: ${candidate.mode === "update" ? "更新中继配置" : desktop ? "远程桌面完整控制授权" : "首次配对"}`,
              `6 位核对码: ${candidate.code}`,
              "",
            ].join("\n"),
          )
        }

        const abortController = new AbortController()
        confirmAbort = abortController
        let droppedReason: string | null = null

        const pollerPromise = (async () => {
          while (!abortController.signal.aborted && !interrupted) {
            await sleepAbortable(pollIntervalMs, abortController.signal)
            if (abortController.signal.aborted || interrupted) break
            try {
              const nextView = await pollCandidate()
              if (abortController.signal.aborted || interrupted) break
              if (nextView.attempt?.id && nextView.attempt.id !== attemptId) {
                droppedReason = "superseded"
                abortController.abort()
                break
              }
              if (!nextView.attempt) {
                droppedReason = nextView.status === "waiting" ? "cancelled" : nextView.status
                abortController.abort()
                break
              }
              if (
                nextView.status !== "verify" ||
                nextView.attempt.candidate?.confirmation !== candidate.confirmation
              ) {
                droppedReason = nextView.status === "waiting" ? "disconnected" : nextView.status
                abortController.abort()
                break
              }
            } catch {
              droppedReason = "host-unavailable"
              abortController.abort()
              break
            }
          }
        })()

        const answer = await awaitConfirmationWithSignal(
          "确认配对？[y/N] ",
          { name: candidate.name, code: candidate.code, mode: candidate.mode },
          abortController.signal,
          deps,
        )
        abortController.abort()
        await pollerPromise.catch(() => undefined)
        confirmAbort = undefined

        if (interrupted) return await cancelAndExitInterrupted()

        if (droppedReason) {
          if (droppedReason === "disconnected") {
            await cancelAttemptBestEffort(meta.socketPath, attemptId, desktop)
          }
          emitPairingFailure(json, stdout, stderr, droppedReason, formatPairingError(droppedReason))
          return 1
        }

        const normalized = answer?.trim().toLowerCase() ?? ""
        if (normalized === "y" || normalized === "yes") {
          let confirmedStatus: string
          try {
            if (desktop) {
              const res = await callAdminSocket(meta.socketPath, "desktop.pairing.confirm", {
                id: attemptId,
                confirmation: candidate.confirmation,
              })
              confirmedStatus = res.status
            } else {
              const res = await callAdminSocket(meta.socketPath, "mobile.pairing.confirm", {
                id: attemptId,
                confirmation: candidate.confirmation,
              })
              confirmedStatus = res.status
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            emitPairingFailure(json, stdout, stderr, "confirm_failed", `确认配对失败: ${message}`)
            return 1
          }
          if (confirmedStatus === "paired" || confirmedStatus === "update-approved") {
            if (json) {
              stdout.write(
                `${JSON.stringify({
                  event: "paired",
                  role: desktop ? "desktop" : "mobile",
                  status: confirmedStatus,
                  attemptId,
                  name: candidate.name,
                  mode: candidate.mode,
                })}\n`,
              )
            } else {
              stdout.write(
                confirmedStatus === "update-approved"
                  ? `已允许「${candidate.name}」更新中继配置。\n`
                  : `已确认配对「${candidate.name}」。\n`,
              )
            }
            return 0
          }
          if (confirmedStatus === "waiting") {
            await cancelAttemptBestEffort(meta.socketPath, attemptId, desktop)
          }
          emitPairingFailure(
            json,
            stdout,
            stderr,
            confirmedStatus,
            formatPairingError(confirmedStatus),
          )
          return 1
        }

        await cancelAttemptBestEffort(meta.socketPath, attemptId, desktop)
        if (json) {
          stdout.write(`${JSON.stringify({ event: "cancelled", attemptId })}\n`)
        } else {
          stdout.write("已取消配对。\n")
        }
        return 1
      }

      emitPairingFailure(json, stdout, stderr, view.status, formatPairingError(view.status))
      return 1
    }

    return await cancelAndExitInterrupted()
  } finally {
    signalSource.off("SIGINT", onSigInt)
  }
}
