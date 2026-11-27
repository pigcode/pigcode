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

async function cancelAttemptBestEffort(socketPath: string, id: string): Promise<void> {
  await callAdminSocket(socketPath, "mobile.pairing.cancel", { id }, 2_000).catch(() => undefined)
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

/** 执行 `pigcode-host pair` 交互式终端扫码配对流程。 */
export async function runPairCommand(deps: PairCommandDeps): Promise<number> {
  const { profileDir, showRaw, json, stdout, stderr, signalSource, pollIntervalMs } = deps
  const meta = await probeLiveHost(profileDir)
  if (!meta) {
    emitPairingFailure(
      json,
      stdout,
      stderr,
      "host_not_running",
      "Pigcode Host 未运行，请先执行 pigcode-host start 启动常驻服务。",
    )
    return 1
  }

  let startView
  try {
    startView = await callAdminSocket(meta.socketPath, "mobile.pairing.start", {})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emitPairingFailure(json, stdout, stderr, "admin_error", `启动配对失败: ${message}`)
    return 1
  }

  if (startView.status !== "waiting" || !startView.attempt?.qr) {
    emitPairingFailure(json, stdout, stderr, startView.status, formatPairingError(startView.status))
    return 1
  }

  const attemptId = startView.attempt.id
  const qrPayload = startView.attempt.qr

  if (json) {
    stdout.write(
      `${JSON.stringify({
        event: "waiting",
        attemptId,
        expiresAt: startView.attempt.expiresAt,
        qr: qrPayload,
      })}\n`,
    )
  } else {
    const qrTerminal = await QRCode.toString(qrPayload, {
      type: "terminal",
      small: true,
      errorCorrectionLevel: "L",
    })
    stdout.write("请使用 Pigcode 手机端扫描以下二维码（按 Ctrl+C 取消）：\n")
    stdout.write(qrTerminal)
    if (!qrTerminal.endsWith("\n")) stdout.write("\n")
    stdout.write(`有效期至: ${new Date(startView.attempt.expiresAt).toLocaleTimeString()}\n`)
    if (showRaw) {
      stdout.write(`原始配对数据: ${qrPayload}\n`)
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
    await cancelAttemptBestEffort(meta.socketPath, attemptId)
    emitPairingFailure(json, stdout, stderr, "cancelled", "已取消配对。")
    return 130
  }

  try {
    while (!interrupted) {
      await sleepAbortable(pollIntervalMs, waitAbort.signal)
      if (interrupted) return await cancelAndExitInterrupted()

      let view
      try {
        view = await callAdminSocket(meta.socketPath, "mobile.pairing.view", {})
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

      if (view.attempt?.id !== attemptId) {
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
              `收到配对请求: ${candidate.name}`,
              `请求类型: ${candidate.mode === "update" ? "更新中继配置" : "首次配对"}`,
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
              const nextView = await callAdminSocket(meta.socketPath, "mobile.pairing.view", {})
              if (abortController.signal.aborted || interrupted) break
              if (
                nextView.attempt?.id !== attemptId ||
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
            await cancelAttemptBestEffort(meta.socketPath, attemptId)
          }
          emitPairingFailure(json, stdout, stderr, droppedReason, formatPairingError(droppedReason))
          return 1
        }

        const normalized = answer?.trim().toLowerCase() ?? ""
        if (normalized === "y" || normalized === "yes") {
          const confirmed = await callAdminSocket(meta.socketPath, "mobile.pairing.confirm", {
            id: attemptId,
            confirmation: candidate.confirmation,
          })
          if (confirmed.status === "paired" || confirmed.status === "update-approved") {
            if (json) {
              stdout.write(
                `${JSON.stringify({
                  event: "paired",
                  status: confirmed.status,
                  attemptId,
                  name: candidate.name,
                  mode: candidate.mode,
                })}\n`,
              )
            } else {
              stdout.write(
                confirmed.status === "update-approved"
                  ? `已允许「${candidate.name}」更新中继配置。\n`
                  : `已确认配对「${candidate.name}」。\n`,
              )
            }
            return 0
          }
          emitPairingFailure(
            json,
            stdout,
            stderr,
            confirmed.status,
            formatPairingError(confirmed.status),
          )
          return 1
        }

        await cancelAttemptBestEffort(meta.socketPath, attemptId)
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
