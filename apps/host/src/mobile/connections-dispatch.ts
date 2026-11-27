/** 处理已连接 Peer 的 Noise 解密、分帧重组、身份握手及桌面端 RPC 服务挂载。 */
import { DESKTOP_RPC_MAX_BYTES } from "@pigcode/contracts"
import type { Context } from "cordis"
import { RpcServer } from "../rpc/server"
import type { ThreadFeed } from "../rpc/thread-feed"
import type { RelaySettings } from "../services/relay-settings"
import {
  authenticatePeer,
  negotiatePeer,
  requestPeerApproval,
  sendPeerMessage,
  type Peer,
  type PeerHostContext,
} from "./connections-peer"
import { FrameAssembler, MOBILE_MAX_MESSAGE_BYTES } from "./mobile-frames"
import type { NoiseKeyPair } from "./noise"
import type { PairedDevices } from "./paired-devices"
import type { DesktopAttempt, MobileAttempt } from "./pairing-attempt"
import type { MobilePushReminders } from "./push-reminders"
import { deviceRevokedNotice, tellRevokedDevice } from "./revocation"

/** 清理并断开绑定到指定配对尝试的挂起 Peer。 */
export function releaseAttemptPeers(
  attempt: MobileAttempt | DesktopAttempt | undefined,
  peers: ReadonlyMap<number, Peer>,
  dropPeer: (session: number, close: boolean) => void,
): void {
  if (!attempt) return
  clearTimeout(attempt.timer)
  attempt.secret.fill(0)
  for (const [session, peer] of peers) {
    if (peer.attempt === attempt) dropPeer(session, true)
  }
}

/** 断开属于被撤销公钥的所有活跃/挂起 Peer，必要时发送吊销通知。 */
export function disconnectRevokedPeers(opts: {
  peers: ReadonlyMap<number, Peer>
  publicKey: string
  mobileAttempt: MobileAttempt | undefined
  desktopAttempt: DesktopAttempt | undefined
  forceNotice: boolean
  dropPeer: (session: number, close: boolean) => void
}): boolean {
  let cancelAttempt = false
  for (const [session, peer] of opts.peers) {
    if (peer.device?.publicKey !== opts.publicKey) continue
    cancelAttempt ||=
      peer.attempt !== undefined &&
      (peer.attempt === opts.mobileAttempt || peer.attempt === opts.desktopAttempt)
    tellRevokedDevice(opts.forceNotice || peer.revocationNotice, () =>
      sendPeerMessage(peer, deviceRevokedNotice),
    )
    opts.dropPeer(session, true)
  }
  return cancelAttempt
}

export function approvePeerCandidate<TView>(opts: {
  id: string
  confirmation: string
  attempt: MobileAttempt | DesktopAttempt | undefined
  peers: ReadonlyMap<number, Peer>
  devices: PairedDevices
  armPeer: (session: number, peer: Peer) => void
  dropPeer: (session: number, close: boolean) => void
  viewFor: () => TView
  onStorageError: () => void
  prepareDevice: (device: NonNullable<Peer["device"]>) => NonNullable<Peer["device"]>
  approvedPayload: () => unknown
  onApproved: (candidate: NonNullable<MobileAttempt["candidate"]>) => void
}): TView {
  const candidate = opts.attempt?.candidate
  if (opts.attempt?.id !== opts.id || !candidate || candidate.confirmation !== opts.confirmation) {
    return opts.viewFor()
  }
  const peer = opts.peers.get(candidate.session)
  if (peer?.phase !== "approval" || !peer.device || peer.attempt !== opts.attempt) {
    return opts.viewFor()
  }
  const base = opts.devices.find(peer.device.publicKey) ?? peer.device
  try {
    opts.devices.save(opts.prepareDevice(base))
  } catch {
    opts.dropPeer(candidate.session, true)
    opts.onStorageError()
    return opts.viewFor()
  }
  peer.attempt = undefined
  peer.phase = "hello"
  opts.armPeer(candidate.session, peer)
  try {
    sendPeerMessage(peer, opts.approvedPayload())
  } catch {
    opts.dropPeer(candidate.session, true)
  }
  opts.onApproved(candidate as NonNullable<MobileAttempt["candidate"]>)
  return opts.viewFor()
}

/** 构造供 peer 握手和 RPC 模块使用的宿主上下文适配器。 */
export function createPeerHostContext(opts: {
  ctx: Context
  feed: ThreadFeed
  devices: PairedDevices
  relay: RelaySettings
  push: MobilePushReminders
  hostName: () => string
  now: () => number
  currentMobileAttempt: () => MobileAttempt | undefined
  currentDesktopAttempt: () => DesktopAttempt | undefined
  lanAddresses: () => string[]
  armPeer: (session: number, peer: Peer) => void
  dropPeer: (session: number, close?: boolean) => void
  onMobileVerifyStatus: () => void
  onDesktopVerifyStatus: () => void
}): PeerHostContext {
  return {
    ...opts,
    computerName: opts.hostName,
    serveDesktopRpc: (transport) => serveDesktopRpcTransport(opts.ctx, opts.feed, transport),
  }
}

/** 将已认证的桌面端加密传输桥接到 Host `RpcServer`。 */
export function serveDesktopRpcTransport(
  ctx: Context,
  feed: ThreadFeed,
  transport: { send: (msg: unknown) => void; close: () => void },
): NonNullable<Peer["rpc"]> {
  let onIncoming: ((message: unknown) => void) | undefined
  const server = new RpcServer(
    ctx,
    {
      send: (out) => transport.send(out),
      onMessage(listener) {
        onIncoming = listener
        return () => {
          onIncoming = undefined
        }
      },
      close: () => transport.close(),
    },
    feed,
  )
  server.start()
  return {
    receive: (msg) => onIncoming?.(msg),
    close: () => {
      server.stop()
      transport.close()
    },
  }
}

/** 解密并分发单帧 Peer 消息，涵盖 handshake / proof / approval / hello / ready 五个阶段。 */
export function dispatchPeerCiphertext(opts: {
  identity: NoiseKeyPair
  session: number
  peer: Peer
  ciphertext: Buffer
  host: PeerHostContext
  dropPeer: (session: number, close: boolean) => void
}): void {
  const { identity, session, peer, ciphertext, host, dropPeer } = opts
  try {
    if (peer.phase === "handshake") {
      authenticatePeer(host, identity, session, peer, ciphertext)
      return
    }
    if (!peer.noise) throw new Error("missing Noise session")
    const plain = peer.noise.decrypt(ciphertext)
    const assembler =
      peer.assembler ??
      new FrameAssembler(peer.role === "desktop" ? DESKTOP_RPC_MAX_BYTES : MOBILE_MAX_MESSAGE_BYTES)
    peer.assembler = assembler
    const assembled = assembler.push(plain)
    if (!assembled.complete) return
    const message = assembled.message
    switch (peer.phase) {
      case "proof":
        requestPeerApproval(host, session, peer, message)
        break
      case "approval":
        dropPeer(session, true)
        break
      case "hello":
        negotiatePeer(host, identity, session, peer, message)
        break
      case "ready":
        peer.rpc?.receive(message)
        break
    }
  } catch {
    dropPeer(session, true)
  }
}
