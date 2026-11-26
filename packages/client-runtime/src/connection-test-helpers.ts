/** Connection 单测共享辅助函数：构造事件、收发 RPC 与订阅线程。 */
import type { ThreadEvent } from "@pigcode/contracts"
import type { MemoryTransport } from "../../../apps/host/src/rpc/memory-transport"
import type { Connection } from "./connection"

/** Host 收到的一条 RPC 请求。 */
export interface HostRequest {
  id?: string
  method?: string
  params?: Record<string, unknown>
}

/** 构造一条线程事件；seq 由调用方指定。 */
export function threadEvent(threadId: string, seq: number, type: ThreadEvent["type"]): ThreadEvent {
  return {
    seq,
    threadId,
    runId: "run_1",
    type,
    payload: {},
    schemaVersion: 1,
    createdAt: "2026-10-20T00:00:00.000Z",
  }
}

/** 读取 Host 收到的下一条请求。 */
export async function nextRequest(transport: MemoryTransport): Promise<HostRequest> {
  return (await transport.host.next()) as HostRequest
}

/** 给请求发送成功响应。 */
export function respond(transport: MemoryTransport, request: HostRequest, result: unknown): void {
  transport.host.send({ jsonrpc: "2.0", id: request.id, result })
}

/** 订阅一个线程并立即返回空快照。 */
export async function open(
  connection: Connection,
  transport: MemoryTransport,
  threadId: string,
): Promise<HostRequest> {
  const pending = connection.openThread(threadId)
  const request = await nextRequest(transport)
  if (request.method !== "thread.subscribe") {
    throw new Error(`expected thread.subscribe, got ${String(request.method)}`)
  }
  respond(transport, request, { snapshot: {}, cursor: 0, events: [] })
  await pending
  return request
}
