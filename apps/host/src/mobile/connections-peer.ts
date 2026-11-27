import { randomUUID, timingSafeEqual } from "node:crypto"
import {
  DESKTOP_RPC_MAX_BYTES,
  desktopHelloSchema,
  desktopPlatformSchema,
  desktopProtocolVersion,
  deviceHandshakeSchema,
  mobileFeatures,
  mobileHelloSchema,
  mobileProtocolVersion,
  type ClientRole,
  type DesktopPlatform,
  type PairedDevice,
} from "@pigcode/contracts"
import type { HostTransport } from "@pigcode/client-runtime/transport"
import type { Context } from "cordis"
import type { ThreadFeed } from "../rpc/thread-feed"
import type { RelaySettings } from "../services/relay-settings"
import { FrameAssembler, MOBILE_MAX_MESSAGE_BYTES, mobileFrames } from "./mobile-frames"
import { acceptNoise, type NoiseKeyPair, type NoiseSession } from "./noise"
import { deviceRoleOf, type PairedDevices } from "./paired-devices"
import type { Attempt, DesktopAttempt, MobileAttempt } from "./pairing-attempt"
import type { MobilePushReminders } from "./push-reminders"
import { denyUnpairedDevice } from "./revocation"
import { serveMobileSidebar } from "./sidebar-rpc"

export interface PeerTransport {
  readonly channel: "relay" | "lan"
  send(payload: Buffer): void
  close(): void
}

export interface PeerRpcHandle {
  receive(message: unknown): void
  close(): void
}

export interface Peer {
  phase: "handshake" | "proof" | "approval" | "hello" | "ready"
  role?: ClientRole | undefined
  transport: PeerTransport
  assembler?: FrameAssembler | undefined
  timer?: ReturnType<typeof setTimeout>
  noise?: NoiseSession
  device?: PairedDevice | undefined
  attempt?: Attempt | undefined
  rpc?: PeerRpcHandle | undefined
  revocationNotice?: boolean
}

export interface PeerHostContext {
  ctx: Context
  feed: ThreadFeed
  devices: PairedDevices
  relay: RelaySettings
  push: MobilePushReminders
  computerName: () => string
  now: () => number
  currentMobileAttempt: () => MobileAttempt | undefined
  currentDesktopAttempt: () => DesktopAttempt | undefined
  lanAddresses: () => string[]
  armPeer: (session: number, peer: Peer) => void
  dropPeer: (session: number, close?: boolean) => void
  onMobileVerifyStatus: () => void
  onDesktopVerifyStatus: () => void
  serveDesktopRpc: (transport: HostTransport) => PeerRpcHandle
}

export function sendPeerMessage(peer: Peer, message: unknown): void {
  if (!peer.noise) throw new Error("peer session closed")
  const limit = peer.role === "desktop" ? DESKTOP_RPC_MAX_BYTES : MOBILE_MAX_MESSAGE_BYTES
  for (const frame of mobileFrames(message, limit)) {
    peer.transport.send(peer.noise.encrypt(frame))
  }
}

export function authenticatePeer(
  host: PeerHostContext,
  identity: NoiseKeyPair,
  session: number,
  peer: Peer,
  ciphertext: Buffer,
): void {
  const handshake = acceptNoise(identity, ciphertext)
  const request = deviceHandshakeSchema.parse(JSON.parse(handshake.payload.toString("utf8")))
  const publicKey = handshake.publicKey.toString("base64url")
  if (publicKey === identity.publicKey.toString("base64url")) {
    throw new Error("cannot pair a host with itself")
  }
  const registered = host.devices.find(publicKey)
  if (request.type === "device.connect") {
    if (!registered) {
      denyUnpairedDevice(request.revocationNotice, handshake, (message) =>
        peer.transport.send(message),
      )
      return host.dropPeer(session, true)
    }
    const registeredRole = deviceRoleOf(registered)
    peer.device = { ...registered, role: registeredRole }
    peer.role = registeredRole
    peer.assembler = new FrameAssembler(
      registeredRole === "desktop" ? DESKTOP_RPC_MAX_BYTES : MOBILE_MAX_MESSAGE_BYTES,
    )
    peer.phase = "hello"
  } else {
    const role: ClientRole =
      request.type === "device.updateRelay" ? "mobile" : (request.role ?? "mobile")
    if (registered && deviceRoleOf(registered) !== role) {
      throw new Error("paired device role mismatch")
    }
    const supplied = Buffer.from(request.secret, "base64url")
    if (supplied.length !== 32) throw new Error("invalid pairing secret")

    let attempt: Attempt | undefined
    if (role === "mobile") {
      if (peer.transport.channel !== "relay") throw new Error("mobile pairing requires relay")
      const mobileAttempt = host.currentMobileAttempt()
      if (!mobileAttempt?.qr || !timingSafeEqual(mobileAttempt.secret, supplied)) {
        throw new Error("unknown mobile pairing attempt")
      }
      attempt = mobileAttempt
    } else {
      const desktopAttempt = host.currentDesktopAttempt()
      if (!desktopAttempt?.link || !timingSafeEqual(desktopAttempt.secret, supplied)) {
        throw new Error("unknown desktop pairing attempt")
      }
      attempt = desktopAttempt
    }

    let device = registered
    if (!device) {
      if (request.type !== "device.pair") throw new Error("unpaired device")
      device = {
        role,
        name: request.name,
        platform: request.platform,
        publicKey,
        lastConnectedAt: null,
      }
    }
    peer.device = device
    peer.role = role
    peer.attempt = attempt
    peer.assembler = new FrameAssembler(
      role === "desktop" ? DESKTOP_RPC_MAX_BYTES : MOBILE_MAX_MESSAGE_BYTES,
    )
    peer.phase = "proof"
  }
  const response = handshake.reply()
  peer.noise = response.session
  host.armPeer(session, peer)
  peer.transport.send(response.message)
}

export function requestPeerApproval(
  host: PeerHostContext,
  session: number,
  peer: Peer,
  message: unknown,
): void {
  const activeAttempt =
    peer.role === "desktop" ? host.currentDesktopAttempt() : host.currentMobileAttempt()
  if (
    !activeAttempt ||
    peer.attempt !== activeAttempt ||
    activeAttempt.candidate ||
    !peer.noise ||
    !peer.device ||
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "device.confirm"
  ) {
    throw new Error("invalid pairing confirmation")
  }
  clearTimeout(peer.timer)
  peer.phase = "approval"
  if (activeAttempt.role === "mobile") {
    activeAttempt.candidate = {
      session,
      confirmation: randomUUID(),
      code: peer.noise.verificationCode,
      name: peer.device.name,
      mode: host.devices.find(peer.device.publicKey) ? "update" : "pair",
    }
    sendPeerMessage(peer, { type: "device.check" })
    host.onMobileVerifyStatus()
  } else {
    activeAttempt.candidate = {
      session,
      confirmation: randomUUID(),
      code: peer.noise.verificationCode,
      name: peer.device.name,
      platform: desktopPlatformSchema.parse(peer.device.platform) as DesktopPlatform,
    }
    sendPeerMessage(peer, { type: "device.check" })
    host.onDesktopVerifyStatus()
  }
}

export function negotiatePeer(
  host: PeerHostContext,
  identity: NoiseKeyPair,
  session: number,
  peer: Peer,
  message: unknown,
): void {
  const device = peer.device && host.devices.find(peer.device.publicKey)
  if (!device) throw new Error("device not authorized")
  if (deviceRoleOf(device) !== peer.role) throw new Error("device role mismatch")

  const lanAddresses = host.lanAddresses()
  const hostName = host.computerName()

  if (peer.role === "desktop") {
    const hello = desktopHelloSchema.parse(message)
    if (hello.minVersion > desktopProtocolVersion || hello.maxVersion < desktopProtocolVersion) {
      sendPeerMessage(peer, {
        type: "desktop.incompatible",
        minVersion: desktopProtocolVersion,
        maxVersion: desktopProtocolVersion,
      })
      host.dropPeer(session, true)
      return
    }
    peer.revocationNotice = true
    peer.device = { ...device, lastConnectedAt: host.now() }
    host.devices.save(peer.device)

    let receiver: ((msg: unknown) => void) | undefined
    peer.rpc = host.serveDesktopRpc({
      send: (out) => sendPeerMessage(peer, out),
      onMessage(listener) {
        receiver = listener
        return () => {
          receiver = undefined
        }
      },
      close() {
        receiver = undefined
      },
    })
    if (receiver) {
      const forward = receiver
      peer.rpc = {
        receive: forward,
        close: peer.rpc.close,
      }
    }
    peer.phase = "ready"
    clearTimeout(peer.timer)
    sendPeerMessage(peer, {
      type: "desktop.welcome",
      version: desktopProtocolVersion,
      hostKey: identity.publicKey.toString("base64url"),
      hostName,
      runtime: process.versions.electron ? "desktop" : "headless",
      ...(lanAddresses.length > 0 ? { lanAddresses } : {}),
    })
    return
  }

  const hello = mobileHelloSchema.parse(message)
  if (hello.minVersion > mobileProtocolVersion || hello.maxVersion < mobileProtocolVersion) {
    sendPeerMessage(peer, {
      type: "mobile.incompatible",
      minVersion: mobileProtocolVersion,
      maxVersion: mobileProtocolVersion,
    })
    host.dropPeer(session, true)
    return
  }
  const features = mobileFeatures.filter((feature) => hello.features.includes(feature))
  peer.revocationNotice = features.includes("connection.revocation")
  peer.device = { ...device, lastConnectedAt: host.now() }
  host.devices.save(peer.device)
  peer.rpc = serveMobileSidebar(
    host.ctx,
    host.feed,
    host.devices,
    {
      computerKey: identity.publicKey,
      computerName: hostName,
      deviceKey: device.publicKey,
      features,
      relayRevision: () => host.relay.revision,
      configureReminders: (settings) => host.push.report(device.publicKey, settings),
    },
    (out) => sendPeerMessage(peer, out),
  )
  peer.phase = "ready"
  clearTimeout(peer.timer)
  sendPeerMessage(peer, {
    type: "mobile.welcome",
    version: mobileProtocolVersion,
    features,
    computerName: hostName,
    ...(lanAddresses.length > 0 ? { lanAddresses } : {}),
  })
}
