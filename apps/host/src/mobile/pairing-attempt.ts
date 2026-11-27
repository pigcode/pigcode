import {
  encodeDesktopPairingLink,
  type DesktopPairingView,
  type DesktopPlatform,
  type MobilePairingView,
} from "@pigcode/contracts"

export const pairingValidityMs = 180_000

type MobileAttemptView = NonNullable<MobilePairingView["attempt"]>
type MobileCandidate = NonNullable<MobileAttemptView["candidate"]>
type DesktopAttemptView = NonNullable<DesktopPairingView["attempt"]>
type DesktopCandidate = NonNullable<DesktopAttemptView["candidate"]>

export interface MobileAttempt {
  role: "mobile"
  id: string
  expiresAt: number
  secret: Buffer
  timer: ReturnType<typeof setTimeout>
  qr: string | null
  candidate: (MobileCandidate & { session: number }) | null
}

export interface DesktopAttempt {
  role: "desktop"
  id: string
  expiresAt: number
  secret: Buffer
  timer: ReturnType<typeof setTimeout>
  link: string | null
  lanAddresses: string[]
  candidate: (DesktopCandidate & { session: number }) | null
}

export type Attempt = MobileAttempt | DesktopAttempt

export function pairingQRCode(
  attempt: MobileAttempt,
  relay: { address: string; token: string },
  publicKey: Buffer,
  computerName: string,
): string {
  return JSON.stringify({
    type: "pigcode.pair",
    version: 1,
    address: relay.address,
    token: relay.token,
    computerKey: publicKey.toString("base64url"),
    computerName,
    secret: attempt.secret.toString("base64url"),
    expiresAt: attempt.expiresAt,
  })
}

export function desktopPairingLink(
  attempt: DesktopAttempt,
  relay: { address: string; token: string } | null,
  publicKey: Buffer,
  hostName: string,
  lanAddresses: string[],
): string {
  return encodeDesktopPairingLink({
    type: "pigcode.desktopPair",
    version: 1,
    address: relay?.address ?? null,
    token: relay?.token ?? null,
    ...(lanAddresses.length > 0 ? { lanAddresses } : {}),
    hostKey: publicKey.toString("base64url"),
    hostName,
    secret: attempt.secret.toString("base64url"),
    expiresAt: attempt.expiresAt,
  })
}

export function pairingAttemptView(attempt: MobileAttempt | undefined): MobileAttemptView | null {
  if (!attempt) return null
  const { id, expiresAt, qr, candidate } = attempt
  return {
    id,
    expiresAt,
    qr,
    candidate: candidate
      ? {
          confirmation: candidate.confirmation,
          code: candidate.code,
          name: candidate.name,
          mode: candidate.mode,
        }
      : null,
  }
}

export function desktopPairingAttemptView(
  attempt: DesktopAttempt | undefined,
): DesktopAttemptView | null {
  if (!attempt) return null
  const { id, expiresAt, link, lanAddresses, candidate } = attempt
  return {
    id,
    expiresAt,
    link,
    lanAddresses,
    candidate: candidate
      ? {
          confirmation: candidate.confirmation,
          code: candidate.code,
          name: candidate.name,
          platform: candidate.platform as DesktopPlatform,
        }
      : null,
  }
}
