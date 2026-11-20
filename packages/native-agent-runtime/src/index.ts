import { randomUUID } from "node:crypto"
import type { AgentExecutionModes, AgentFeatures, AgentStatus } from "@pigcode/contracts"
import { DEFAULT_RUNTIME_MODE, runtimeModeSchema } from "@pigcode/contracts"
import type {
  AgentDriver,
  AgentInstanceContext,
  AgentModelInfo,
  AgentRuntime,
  AgentSessionHandle,
  AgentSettingsValues,
  CreateSessionInput,
  UserInput,
} from "@pigcode/plugin-sdk"

/** 一轮期间借用的原生会话。关闭客户端只释放进程或连接，保留 Agent 自己的历史。 */
export interface NativeSession {
  nativeId: string
  send(input: UserInput, runtime: AgentRuntime): Promise<void>
  interrupt(): Promise<void>
  close(): Promise<void>
}

interface Active {
  id: string
  nativeKey: string
  sending: boolean
  session: NativeSession
  controller: AbortController
  closing?: Promise<void>
  cancelling?: Promise<void>
}

export const missingNativeSession = "The native Agent session no longer exists"

export abstract class NativeAgentDriver implements AgentDriver {
  abstract readonly id: string
  abstract readonly displayName: string
  abstract readonly features: AgentFeatures
  abstract readonly executionModes: AgentExecutionModes
  readonly modelSwitch = "resume" as const
  abstract detect(
    settings: AgentSettingsValues,
    instance?: AgentInstanceContext,
  ): Promise<AgentStatus>
  abstract listModels(
    settings: AgentSettingsValues,
    instance?: AgentInstanceContext,
  ): Promise<AgentModelInfo[]>
  protected abstract open(input: CreateSessionInput, signal: AbortSignal): Promise<NativeSession>

  private readonly stop = new AbortController()
  private readonly active = new Map<string, Active>()
  private readonly nativeSessions = new Map<string, Active>()
  private readonly openingKeys = new Set<string>()
  private readonly opening = new Set<Promise<AgentSessionHandle>>()

  createSession(input: CreateSessionInput): Promise<AgentSessionHandle> {
    const opening = this.openSession(input)
    this.opening.add(opening)
    return opening.finally(() => this.opening.delete(opening))
  }

  private async openSession(input: CreateSessionInput): Promise<AgentSessionHandle> {
    const id = input.sessionId ?? randomUUID()
    const signal = input.signal
      ? AbortSignal.any([input.signal, this.stop.signal])
      : this.stop.signal
    signal.throwIfAborted()
    const permissionMode = input.permissionMode ?? DEFAULT_RUNTIME_MODE
    const parsed = runtimeModeSchema.safeParse(permissionMode)
    if (
      !parsed.success ||
      (this.executionModes.permissions && !this.executionModes.permissions.includes(parsed.data))
    )
      throw new Error(
        this.displayName + " does not support runtime permission mode: " + permissionMode,
      )
    if (input.planMode && !this.executionModes.plan)
      throw new Error(this.displayName + " does not support plan mode")
    const keyFor = (kind: string, value: string) =>
      JSON.stringify([input.instance?.instanceId, kind, value])
    const nativeKey = input.nativeSessionId ? keyFor("native", input.nativeSessionId) : undefined
    const keys = [keyFor("handle", id), ...(nativeKey ? [nativeKey] : [])]
    if (keys.some((key) => this.openingKeys.has(key)))
      throw new Error("This native Agent session is already opening")
    for (const key of keys) this.openingKeys.add(key)
    try {
      // The host may allocate a fresh Pigcode handle when restoring the same native conversation.
      const previous = new Set([
        this.active.get(id),
        nativeKey ? this.nativeSessions.get(nativeKey) : undefined,
      ])
      for (const active of previous) {
        if (!active) continue
        if (active.sending && !active.cancelling && !active.closing)
          throw new Error("This native Agent session is in use")
        await untilAbort(this.release(active), signal)
      }
      signal.throwIfAborted()
      const session = await this.open({ ...input, permissionMode }, signal)
      const key = keyFor("native", session.nativeId)
      if (signal.aborted || this.nativeSessions.has(key)) {
        await session.close()
        signal.throwIfAborted()
        throw new Error("This native Agent session is in use")
      }
      const active: Active = {
        id,
        nativeKey: key,
        session,
        controller: new AbortController(),
        sending: false,
      }
      this.active.set(id, active)
      this.nativeSessions.set(key, active)
      return {
        id,
        threadId: input.threadId,
        cwd: input.cwd,
        nativeSessionId: session.nativeId,
        model: input.model ?? null,
        permissionMode,
        planMode: input.planMode ?? false,
      }
    } finally {
      for (const key of keys) this.openingKeys.delete(key)
    }
  }

  async send(handle: AgentSessionHandle, input: UserInput, runtime: AgentRuntime) {
    const active = this.active.get(handle.id)
    if (!active || active.closing) throw new Error(missingNativeSession)
    if (active.sending) throw new Error("This native Agent session is in use")
    active.sending = true
    const signal = AbortSignal.any([runtime.signal, active.controller.signal, this.stop.signal])
    const cancel = () => {
      void this.cancel(active).catch(() => undefined)
    }
    signal.addEventListener("abort", cancel, { once: true })
    try {
      signal.throwIfAborted()
      runtime.emit({ type: "session.started", nativeSessionId: active.session.nativeId })
      await untilAbort(active.session.send(input, { ...runtime, signal }), signal)
    } catch (error) {
      if (!signal.aborted) throw error
    } finally {
      signal.removeEventListener("abort", cancel)
      await this.release(active)
    }
  }

  private cancel(active: Active) {
    if (active.closing) return active.closing
    active.cancelling ??= active.session.interrupt()
    return active.cancelling
  }
  async interrupt(handle: AgentSessionHandle) {
    const active = this.active.get(handle.id)
    if (!active) return
    active.controller.abort()
    await this.cancel(active)
  }
  private release(active: Active) {
    active.closing ??= (async () => {
      try {
        await active.cancelling?.catch(() => undefined)
        await active.session.close()
      } finally {
        if (this.active.get(active.id) === active) this.active.delete(active.id)
        if (this.nativeSessions.get(active.nativeKey) === active)
          this.nativeSessions.delete(active.nativeKey)
      }
    })()
    return active.closing
  }
  async dispose(handle: AgentSessionHandle) {
    const active = this.active.get(handle.id)
    if (!active) return
    active.controller.abort()
    await this.release(active)
  }
  async close() {
    this.stop.abort()
    await Promise.allSettled([...this.opening])
    await Promise.allSettled([...this.active.values()].map((active) => this.release(active)))
  }
  isSessionNotFound(message: string) {
    return message === missingNativeSession
  }
}

export function promptText(input: UserInput) {
  return input.handoff ? input.handoff + "\n\n" + input.text : input.text
}

export const nativeFeatures: AgentFeatures = {
  streaming: true,
  approvals: false,
  questions: false,
  plan: false,
  resume: true,
  fork: false,
  rollback: false,
  checkpoint: false,
  subagents: false,
  mcp: false,
  images: false,
  usage: false,
  modelCatalog: true,
  nativeSessionId: true,
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
export const stringValue = (value: unknown) => (typeof value === "string" ? value : "")

/** 提前结束本次等待；资源的所有者负责在 finally 关闭底层连接。 */
export async function untilAbort<T>(action: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      action,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason)
        if (signal.aborted) abort()
        else signal.addEventListener("abort", abort, { once: true })
      }),
    ])
  } finally {
    if (abort) signal.removeEventListener("abort", abort)
  }
}
