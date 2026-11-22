import {
  RELAY_PROTOCOL_VERSION,
  relayProbeResultSchema,
  type RelayProbeStatus,
} from "@pigcode/contracts"

type ProbeStatus = RelayProbeStatus | "unreachable"

export type RelayProbe = (address: string, token: string) => Promise<ProbeStatus>

/** One control exchange without registering the computer on the relay. */
export const probeRelay: RelayProbe = (address, token) => {
  let socket: WebSocket
  try {
    socket = new WebSocket(address)
  } catch {
    return Promise.resolve("unreachable")
  }

  return new Promise((resolve) => {
    let finished = false
    const finish = (status: ProbeStatus) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      resolve(status)
      if (socket.readyState < WebSocket.CLOSING) socket.close()
    }
    const timeout = setTimeout(() => finish("unreachable"), 5_000)
    socket.addEventListener(
      "open",
      () => {
        try {
          socket.send(
            JSON.stringify({ type: "relay.probe", version: RELAY_PROTOCOL_VERSION, token }),
          )
        } catch {
          finish("unreachable")
        }
      },
      { once: true },
    )
    socket.addEventListener(
      "message",
      ({ data }) => {
        if (typeof data !== "string" || Buffer.byteLength(data) > 8192) {
          finish("incompatible")
          return
        }
        try {
          const result = relayProbeResultSchema.safeParse(JSON.parse(data))
          finish(result.success ? result.data.status : "incompatible")
        } catch {
          finish("incompatible")
        }
      },
      { once: true },
    )
    socket.addEventListener("error", () => finish("unreachable"), { once: true })
    socket.addEventListener("close", () => finish("unreachable"), { once: true })
  })
}
