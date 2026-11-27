import type { DesktopPlatform } from "@pigcode/contracts"
import type { RemoteNoiseSession } from "./remote-noise-client"

export interface PortLike {
  postMessage(message: unknown): void
  on?(event: "message", listener: (ev: { data: unknown }) => void): void
  addEventListener?(event: "message", listener: (ev: MessageEvent) => void): void
  start?(): void
  close(): void
}

export interface ChannelPair {
  port1: PortLike
  port2: PortLike
}

/** 将 Node 运行时平台标识映射为桌面端配对协议平台值。 */
export function detectDesktopPlatform(raw: NodeJS.Platform = process.platform): DesktopPlatform {
  if (raw === "darwin") return "macos"
  if (raw === "win32") return "windows"
  return "linux"
}

/** 将远端 Noise 会话双向绑定到一对 MessagePort 上。 */
export function bindRemoteSessionPort(
  createChannel: () => ChannelPair,
  session: RemoteNoiseSession,
  onPortReady?: (port: PortLike) => void,
): PortLike {
  const { port1, port2 } = createChannel()
  const unsubscribeSession = session.onMessage((msg) => {
    try {
      port1.postMessage(msg)
    } catch {
      // port closed during reload
    }
  })
  const onPortMsg = (ev: { data: unknown }) => {
    try {
      session.send(ev.data)
    } catch {
      // ignore write on closed remote session
    }
  }
  if (port1.addEventListener) {
    port1.addEventListener("message", onPortMsg as (e: MessageEvent) => void)
  } else {
    port1.on?.("message", onPortMsg)
  }
  port1.start?.()

  const binding: PortLike = {
    postMessage: (m) => port1.postMessage(m),
    close: () => {
      unsubscribeSession()
      try {
        port1.close()
      } catch {
        // ignore
      }
    },
  }
  onPortReady?.(port2)
  return binding
}
