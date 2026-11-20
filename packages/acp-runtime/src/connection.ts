import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
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
}

export interface AcpConnectionOptions {
  name?: string
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
  const tree = ownProcessTree(child)
  const app = client({ name: "Pigcode" })
    .onNotification("session/update", ({ params }) => handlers.update?.(params))
    .onRequest(
      "session/request_permission",
      ({ params }): Promise<RequestPermissionResponse> | RequestPermissionResponse =>
        handlers.approval?.(params) ?? { outcome: { outcome: "cancelled" } },
    )
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
          clientInfo: { name: "pigcode", title: "Pigcode", version: HOST_VERSION },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        requestOptions(signal),
      )
      if (reply.protocolVersion !== PROTOCOL_VERSION)
        throw new Error(`${label} did not negotiate ACP v1`)
      options.validate?.(reply)
      return reply
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
