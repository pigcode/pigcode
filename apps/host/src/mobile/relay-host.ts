import {
  RELAY_PROTOCOL_VERSION,
  relayAdmissionSchema,
  relaySessionControlSchema,
  relayPushInvalidSchema,
  type ApnsEnvironment,
  type HostReminder,
  type MobileApnsRegistration,
  type RelayHostLifecycle,
} from "@pigcode/contracts"
import { createHmac } from "node:crypto"
import { x25519SharedSecret, type NoiseKeyPair } from "./noise"

export interface RelayReminderTarget extends Omit<MobileApnsRegistration, "observationId"> {
  deviceId: string
  registrationId: string
}

export interface RelayPushIdentity {
  identity: NoiseKeyPair
  invalidated(deviceId: string, registrationId: string): void
}

interface RelayHostEvents {
  sessionOpened(session: number): void
  sessionClosed(session: number): void
  received(session: number, ciphertext: Buffer): void
  disconnected(): void
  push?: RelayPushIdentity
}

export interface RelayHost {
  send(session: number, ciphertext: Buffer): void
  closeSession(session: number): void
  announce(state: RelayHostLifecycle): void
  supportsPush(environment: ApnsEnvironment): boolean
  sendReminder(target: RelayReminderTarget, reminder: HostReminder): void
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
    let push: { publicKey: string; proof: string; environments: ApnsEnvironment[] } | undefined
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
      supportsPush(environment) {
        return state === "online" && socket.readyState === WebSocket.OPEN &&
          push?.environments.includes(environment) === true
      },
      sendReminder(target, reminder) {
        if (!push || !connection.supportsPush(target.environment)) return
        socket.send(JSON.stringify({
          type: "relay.push",
          publicKey: push.publicKey,
          proof: push.proof,
          target,
          reminder,
        }))
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
            apnsSupport: events.push ? true : undefined,
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
          if (events.push && result.apnsChallenge && result.apnsEnvironments?.length) {
            const { identity } = events.push
            const challenge = Buffer.from(result.apnsChallenge, "base64url")
            try {
              const secret = x25519SharedSecret(identity, challenge)
              const proof = createHmac("sha256", secret)
                .update("pigcode-relay-apns-v1")
                .update(challenge)
                .update(identity.publicKey)
                .digest("base64url")
              push = {
                publicKey: identity.publicKey.toString("base64url"),
                proof,
                environments: result.apnsEnvironments,
              }
            } catch {
              // A failed push offer does not prevent ordinary session routing.
            }
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
          if (frame.type === "relay.push.invalid") {
            const result = relayPushInvalidSchema.safeParse(frame)
            if (result.success && push) {
              events.push?.invalidated(result.data.deviceId, result.data.registrationId)
            }
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
