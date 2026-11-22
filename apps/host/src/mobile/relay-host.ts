import {
  RELAY_PROTOCOL_VERSION,
  relayAdmissionSchema,
  relaySessionControlSchema,
  type RelayHostLifecycle,
} from "@pigcode/contracts"

interface RelayHostEvents {
  sessionOpened(session: number): void
  sessionClosed(session: number): void
  received(session: number, ciphertext: Buffer): void
  disconnected(): void
}

export interface RelayHost {
  send(session: number, ciphertext: Buffer): void
  closeSession(session: number): void
  announce(state: RelayHostLifecycle): void
  close(): void
}

export function openRelayHost(
  config: { address: string; token: string },
  computerId: string,
  events: RelayHostEvents,
  signal: AbortSignal,
): Promise<RelayHost> {
  const socket = new WebSocket(config.address)
  socket.binaryType = "arraybuffer"
  return new Promise((resolve, reject) => {
    let state: "joining" | "online" | "closed" = "joining"
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let heartbeatMs = 0
    let pongDeadline: ReturnType<typeof setTimeout> | undefined
    const close = () => {
      if (state === "closed") return
      const online = state === "online"
      state = "closed"
      clearTimeout(timeout)
      clearInterval(heartbeat)
      clearTimeout(pongDeadline)
      signal.removeEventListener("abort", close)
      socket.close()
      if (online) events.disconnected()
      else reject(new Error("relay registration failed"))
    }
    const timeout = setTimeout(close, 5_000)
    const waitForPong = () => {
      clearTimeout(pongDeadline)
      pongDeadline = setTimeout(close, 2 * heartbeatMs).unref()
    }
    const connection: RelayHost = {
      send(session, ciphertext) {
        const frame = Buffer.alloc(4 + ciphertext.length)
        frame.writeUInt32BE(session)
        ciphertext.copy(frame, 4)
        if (state === "online") socket.send(frame)
      },
      closeSession(session) {
        if (state === "online") socket.send(JSON.stringify({ type: "relay.close", session }))
      },
      announce(lifecycle) {
        if (state === "online" && heartbeat && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "relay.hostState", state: lifecycle }))
        }
      },
      close,
    }
    socket.addEventListener("open", () => {
      if (state === "joining") {
        socket.send(
          JSON.stringify({
            type: "relay.host",
            version: RELAY_PROTOCOL_VERSION,
            computerId,
            token: config.token,
            statusSupport: true,
          }),
        )
      }
    })
    socket.addEventListener("message", ({ data }) => {
      if (state === "closed") return
      try {
        if (state === "joining") {
          const result = relayAdmissionSchema.parse(JSON.parse(data as string))
          if (result.status !== "ok") {
            close()
            return
          }
          state = "online"
          clearTimeout(timeout)
          signal.removeEventListener("abort", close)
          if (result.heartbeatSeconds) {
            heartbeatMs = result.heartbeatSeconds * 1000
            waitForPong()
            heartbeat = setInterval(() => {
              if (socket.readyState !== WebSocket.OPEN) close()
              else socket.send(JSON.stringify({ type: "relay.ping" }))
            }, heartbeatMs).unref()
          }
          resolve(connection)
        } else if (typeof data === "string") {
          if (data.length > 8192) throw new Error("oversized relay control frame")
          const frame = JSON.parse(data) as { type?: string }
          if (frame.type === "relay.pong" && heartbeatMs > 0) {
            waitForPong()
            return
          }
          const message = relaySessionControlSchema.parse(frame)
          if (message.type === "relay.open") events.sessionOpened(message.session)
          else events.sessionClosed(message.session)
        } else if (data instanceof ArrayBuffer && data.byteLength > 4 && data.byteLength <= 65539) {
          const frame = Buffer.from(data)
          events.received(frame.readUInt32BE(0), frame.subarray(4))
        } else close()
      } catch {
        close()
      }
    })
    socket.addEventListener("error", close)
    socket.addEventListener("close", close)
    signal.addEventListener("abort", close, { once: true })
    if (signal.aborted) close()
  })
}
