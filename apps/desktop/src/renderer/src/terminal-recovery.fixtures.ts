/** 终端恢复相关测试共用的伪终端视图与内存 RPC 连接 helper（#85）。 */
import type * as ReactNamespace from "react"
import { Connection } from "@pigcode/client-runtime"
import type { TerminalViewProps } from "@pigcode/ui-workbench"
import { MemoryTransport } from "../../../../host/src/rpc/memory-transport"

export interface RpcCallRecord {
  method: string
  params: Record<string, unknown>
}

export const writtenByMount: string[][] = []

export function resetWrittenByMount(): void {
  writtenByMount.length = 0
}

export function createFakeTerminalView(React: typeof ReactNamespace) {
  return function FakeTerminalView({ onResize, onReady }: TerminalViewProps) {
    const onResizeRef = React.useRef(onResize)
    const onReadyRef = React.useRef(onReady)
    onResizeRef.current = onResize
    onReadyRef.current = onReady
    React.useEffect(() => {
      const writes: string[] = []
      writtenByMount.push(writes)
      onReadyRef.current?.({
        write: (data: string) => writes.push(data),
        fit: () => undefined,
        focus: () => undefined,
      })
      onResizeRef.current?.(96, 28)
      return () => {
        onReadyRef.current?.(null)
      }
    }, [])
    return React.createElement("div", { "data-testid": "terminal-view" })
  }
}

export async function createTestConnection(
  handler: (method: string, params: Record<string, unknown>, id: string | number) => unknown,
) {
  const transport = new MemoryTransport()
  const calls: RpcCallRecord[] = []
  transport.host.onMessage((raw) => {
    const req = raw as { id?: string | number; method?: string; params?: Record<string, unknown> }
    if (req.id === undefined || !req.method) return
    const params = req.params ?? {}
    calls.push({ method: req.method, params })
    try {
      const result = handler(req.method, params, req.id)
      if (result && typeof (result as Promise<unknown>).then === "function") {
        void (result as Promise<unknown>).then(
          (resolved) => transport.host.send({ jsonrpc: "2.0", id: req.id, result: resolved }),
          (error: unknown) =>
            transport.host.send({
              jsonrpc: "2.0",
              id: req.id,
              error: {
                code: "COMMAND_FAILED",
                message: error instanceof Error ? error.message : String(error),
              },
            }),
        )
      } else {
        transport.host.send({ jsonrpc: "2.0", id: req.id, result })
      }
    } catch (error) {
      transport.host.send({
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: "COMMAND_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
  })

  const connection = new Connection({
    onEvent: () => undefined,
    onDelta: () => undefined,
    onStatus: () => undefined,
  })
  await connection.attach(transport.client)
  return { connection, transport, calls }
}
