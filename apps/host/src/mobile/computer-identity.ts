import { publicKeySchema } from "@pigcode/contracts"
import type { RelayCredentialCipher } from "../services/relay-settings"
import type { SettingsService } from "../services/settings"
import { noiseKeyPair, type NoiseKeyPair } from "./noise"

const identityKey = "mobile.identity"

export async function loadComputerIdentity(
  settings: SettingsService,
  cipher: RelayCredentialCipher,
  hasPairedDevices: boolean,
): Promise<NoiseKeyPair> {
  const sealed = settings.get(identityKey)
  if (typeof sealed === "string") {
    const seed = publicKeySchema.parse(await cipher.open(sealed))
    return noiseKeyPair(Buffer.from(seed, "base64url"))
  }
  if (sealed !== undefined || hasPairedDevices) throw new Error("computer identity unavailable")
  const identity = noiseKeyPair()
  settings.set(identityKey, await cipher.seal(identity.seed.toString("base64url")))
  return identity
}
