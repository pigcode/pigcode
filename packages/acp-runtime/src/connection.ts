import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createInterface } from "node:readline"
import { Readable, Writable } from "node:stream"
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type ContentBlock,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk"
import { HOST_VERSION } from "@pigcode/plugin-sdk"
import { launchTarget, ownProcessTree, PROCESS_TREE_SPAWN_OPTIONS } from "@pigcode/plugin-sdk/node"

export interface AcpLaunch {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  cwd: string
  terminalAuth?: boolean
  authenticateMethod?: string
  legacyProtocolVersion?: 2
}

export interface AcpConnectionOptions {
  name?: string
  initializeMeta?: Record<string, unknown>
  onOutputLine?(line: string): void
  /** 部分 Agent 将长请求的完成通知与 JSON-RPC 回复分开传送。 */
  promptCompletion?(
    method: string,
    params: unknown,
    sessionId: string,
    promptId: string,
  ): string | undefined
  validate?(reply: InitializeResponse): void
}

export const setupTimeout = 90_000

export function requestOptions(signal?: AbortSignal, timeout = setupTimeout) {
  const deadline = AbortSignal.timeout(timeout)
  const cancellationSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
  cancellationSignal.throwIfAborted()
  return { cancellationSignal, stopWaitingOnCancel: true }
}

export function isAuthRequired(error: unknown): boolean {
  return error instanceof RequestError && error.code === -32000
}

export function openAcp(
  launch: AcpLaunch,
  handlers: {
    update?(notification: SessionNotification): void
    approval?(request: RequestPermissionRequest): Promise<RequestPermissionResponse>
  } = {},
  options: AcpConnectionOptions = {},
) {
  const target = launchTarget(launch.command, launch.args)
  if (target.shell)
    throw new Error("Select an executable or a supported launcher for the ACP command")
  const label = options.name ?? "ACP Agent"
  const child = spawn(target.command, target.args, {
    ...PROCESS_TREE_SPAWN_OPTIONS,
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.stderr.resume()
  if (options.onOutputLine) {
    const output = createInterface({ input: child.stderr })
    output.on("line", options.onOutputLine)
    child.once("close", () => output.close())
  }
  const tree = ownProcessTree(child)
  const app = client({ name: "Pigcode" })
    .onNotification("session/update", ({ params }) => handlers.update?.(params))
    .onRequest(
      "session/request_permission",
      ({ params }): Promise<RequestPermissionResponse> | RequestPermissionResponse =>
        handlers.approval?.(params) ?? { outcome: { outcome: "cancelled" } },
    )
  let complete: ((method: string, params: unknown) => void) | undefined
  if (options.promptCompletion)
    app.onNotification("*", ({ method, params }) => complete?.(method, params))
  const connection = app.connect(
    ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      { maxMessageBytes: 16 * 1024 * 1024 },
    ),
  )
  child.once("error", (error) =>
    connection.close(new Error(`${label} could not start: ${error.message}`)),
  )
  child.once("exit", (code, signal) => {
    if (code !== 0) connection.close(new Error(`${label} exited (${signal ?? code})`))
  })
  child.stdin.on("error", () => undefined)
  child.stderr.on("error", () => undefined)
  return {
    agent: connection.agent,
    signal: connection.signal,
    async initialize(signal?: AbortSignal) {
      const reply = await connection.agent.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          ...(options.initializeMeta ? { _meta: options.initializeMeta } : {}),
          clientInfo: { name: "pigcode", title: "Pigcode", version: HOST_VERSION },
          clientCapabilities: {
            ...(launch.terminalAuth ? { auth: { terminal: true } } : {}),
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        requestOptions(signal),
      )
      if (
        reply.protocolVersion !== PROTOCOL_VERSION &&
        !(launch.legacyProtocolVersion && reply.protocolVersion === launch.legacyProtocolVersion)
      )
        throw new Error(`${label} did not negotiate ACP v1`)
      options.validate?.(reply)
      return reply
    },
    async prompt(
      sessionId: string,
      input: string | ContentBlock[],
    ): Promise<{ stopReason: string }> {
      const prompt: ContentBlock[] =
        typeof input === "string" ? [{ type: "text" as const, text: input }] : input
      const fromNotification = options.promptCompletion
      if (!fromNotification)
        return connection.agent.request("session/prompt", { sessionId, prompt })
      const promptId = randomUUID()
      const controller = new AbortController()
      const notification = new Promise<{ stopReason: string }>((resolve) => {
        complete = (method, params) => {
          const reason = fromNotification(method, params, sessionId, promptId)
          if (reason) resolve({ stopReason: reason })
        }
      })
      try {
        return await Promise.race([
          notification,
          connection.agent.request<{ stopReason: string }>(
            "session/prompt",
            {
              sessionId,
              prompt,
              _meta: { promptId, requestId: promptId },
            },
            { cancellationSignal: controller.signal, stopWaitingOnCancel: true },
          ),
        ])
      } finally {
        complete = undefined
        controller.abort()
      }
    },
    async close() {
      connection.close()
      await tree.terminate()
    },
  }
}

export type AcpProcess = ReturnType<typeof openAcp>

export function isMissingAcpSession(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    (error.code === -32002 ||
      /failed to read session .+; retry, or load it|\bsession\b.*\bnot found\b/i.test(
        error.message,
      ))
  )
}

/** 只用已配置的非交互身份重试一次需要授权的原生会话。 */
export async function setupAcpSession<T>(
  rpc: AcpProcess,
  methodId: string | undefined,
  request: () => Promise<T>,
  signal?: AbortSignal,
) {
  try {
    return await request()
  } catch (error) {
    if (!methodId || !isAuthRequired(error)) throw error
    await rpc.agent.request("authenticate", { methodId }, requestOptions(signal))
    return request()
  }
}

/** 非交互账户设置需要在读取模型或创建会话前声明认证方式。 */
export async function authenticateAcp(rpc: AcpProcess, launch: AcpLaunch, signal?: AbortSignal) {
  if (launch.authenticateMethod)
    await rpc.agent.request(
      "authenticate",
      { methodId: launch.authenticateMethod },
      requestOptions(signal),
    )
}
