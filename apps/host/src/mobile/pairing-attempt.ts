import type { MobilePairingView } from "@pigcode/contracts"

export const pairingValidityMs = 180_000

type AttemptView = NonNullable<MobilePairingView["attempt"]>
type Candidate = NonNullable<AttemptView["candidate"]>

export interface Attempt {
  id: string
  expiresAt: number
  secret: Buffer
  timer: ReturnType<typeof setTimeout>
  qr: string | null
  candidate: (Candidate & { session: number }) | null
}

export function pairingAttemptView(attempt: Attempt | undefined): AttemptView | null {
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
