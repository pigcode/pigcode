import { Readable, Writable } from "node:stream"
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk"
import { HOST_VERSION } from "@pigcode/plugin-sdk"
import { ownProcessTree } from "@pigcode/plugin-sdk/node"
import { spawnAgy, type AgyLaunch } from "./launch"

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
  launch: AgyLaunch,
  handlers: {
    update?(notification: SessionNotification): void
    approval?(request: RequestPermissionRequest): Promise<RequestPermissionResponse>
  } = {},
) {
  const child = spawnAgy(launch)
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
  child.once("error", () => connection.close(new Error("Antigravity CLI could not start")))
  child.once("exit", (code, signal) => {
    if (code !== 0) connection.close(new Error(`Antigravity CLI exited (${signal ?? code})`))
  })
  child.stdin.on("error", () => undefined)
  child.stderr.on("error", () => undefined)
  return {
    agent: connection.agent,
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
        throw new Error("Antigravity CLI did not negotiate ACP v1")
      if (
        !reply.agentCapabilities?.sessionCapabilities?.resume ||
        !reply.agentCapabilities.auth?.logout
      )
        throw new Error("Update Antigravity CLI to a version supporting native resume and sign-out")
      return reply
    },
    async close() {
      connection.close()
      await tree.terminate()
    },
  }
}

export type AcpProcess = ReturnType<typeof openAcp>
