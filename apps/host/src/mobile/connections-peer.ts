import { randomUUID, timingSafeEqual } from "node:crypto"
import {
  deviceHandshakeSchema,
  mobileFeatures,
  mobileHelloSchema,
  mobileProtocolVersion,
  type PairedDevice,
} from "@pigcode/contracts"
import type { Context } from "cordis"
import type { ThreadFeed } from "../rpc/thread-feed"
import type { RelaySettings } from "../services/relay-settings"
import { mobileFrames } from "./mobile-frames"
import { acceptNoise, type NoiseKeyPair, type NoiseSession } from "./noise"
import type { PairedDevices } from "./paired-devices"
import type { Attempt } from "./pairing-attempt"
import type { MobilePushReminders } from "./push-reminders"
import { denyUnpairedDevice } from "./revocation"
import { serveMobileSidebar } from "./sidebar-rpc"

export interface PeerTransport {
  readonly channel: "relay" | "lan"
  send(payload: Buffer): void
  close(): void
}

export interface Peer {
  phase: "handshake" | "proof" | "approval" | "hello" | "ready"
  transport: PeerTransport
  timer?: ReturnType<typeof setTimeout>
  noise?: NoiseSession
  device?: PairedDevice | undefined
  attempt?: Attempt | undefined
  rpc?: ReturnType<typeof serveMobileSidebar>
  revocationNotice?: boolean
}

export interface PeerHostContext {
  ctx: Context
  feed: ThreadFeed
  devices: PairedDevices
  relay: RelaySettings
  push: MobilePushReminders
  computerName: string
  now: () => number
  currentAttempt: () => Attempt | undefined
  lanAddresses: () => string[]
  armPeer: (session: number, peer: Peer) => void
  dropPeer: (session: number, close?: boolean) => void
  onVerifyStatus: () => void
}

export function sendPeerMessage(peer: Peer, message: unknown): void {
  if (!peer.noise) throw new Error("mobile session closed")
  for (const frame of mobileFrames(message)) {
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
  const registered = host.devices.find(publicKey)
  if (request.type === "device.connect") {
    if (!registered) {
      denyUnpairedDevice(request.revocationNotice, handshake, (message) =>
        peer.transport.send(message),
      )
      return host.dropPeer(session, true)
    }
    peer.device = registered
    peer.phase = "hello"
  } else {
    if (peer.transport.channel !== "relay") throw new Error("pairing requires relay")
    const attempt = host.currentAttempt()
    const supplied = Buffer.from(request.secret, "base64url")
    if (!attempt?.qr || supplied.length !== 32 || !timingSafeEqual(attempt.secret, supplied)) {
      throw new Error("unknown pairing attempt")
    }
    let device = registered
    if (!device) {
      if (request.type !== "device.pair") throw new Error("unpaired device")
      device = {
        name: request.name,
        platform: request.platform,
        publicKey,
        lastConnectedAt: null,
      }
    }
    peer.device = device
    peer.attempt = attempt
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
  const attempt = host.currentAttempt()
  if (
    !attempt ||
    peer.attempt !== attempt ||
    attempt.candidate ||
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
  attempt.candidate = {
    session,
    confirmation: randomUUID(),
    code: peer.noise.verificationCode,
    name: peer.device.name,
    mode: host.devices.find(peer.device.publicKey) ? "update" : "pair",
  }
  sendPeerMessage(peer, { type: "device.check" })
  host.onVerifyStatus()
}

export function negotiatePeer(
  host: PeerHostContext,
  identity: NoiseKeyPair,
  session: number,
  peer: Peer,
  message: unknown,
): void {
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
  const device = peer.device && host.devices.find(peer.device.publicKey)
  if (!device) throw new Error("device not authorized")
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
      computerName: host.computerName,
      deviceKey: device.publicKey,
      features,
      relayRevision: () => host.relay.revision,
      configureReminders: (settings) => host.push.report(device.publicKey, settings),
    },
    (out) => sendPeerMessage(peer, out),
  )
  peer.phase = "ready"
  clearTimeout(peer.timer)
  const lanAddresses = host.lanAddresses()
  sendPeerMessage(peer, {
    type: "mobile.welcome",
    version: mobileProtocolVersion,
    features,
    computerName: host.computerName,
    ...(lanAddresses.length > 0 ? { lanAddresses } : {}),
  })
}
