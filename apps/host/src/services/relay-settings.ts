import {
  RELAY_CONNECT_PATH,
  type RelaySettingsView,
  type RelayTestAndSaveParams,
  type RelayTestResult,
} from "@pigcode/contracts"
import { z } from "zod"
import { probeRelay, type RelayProbe } from "./relay-probe"
import type { SettingsService } from "./settings"

const key = "relay.connection"
const savedSchema = z.object({ address: z.string(), sealedToken: z.string().min(1) })

export interface RelayCredentialCipher {
  seal(value: string): Promise<string>
  open(value: string): Promise<string>
}

declare module "cordis" {
  interface Context {
    relaySettings: RelaySettings
  }
}

function relayAddress(input: string): string | undefined {
  try {
    const address = new URL(input.trim())
    if (
      address.protocol !== "wss:" ||
      address.username ||
      address.password ||
      address.search ||
      address.hash
    )
      return undefined
    if (address.pathname === "/") address.pathname = RELAY_CONNECT_PATH
    return address.toString()
  } catch {
    return undefined
  }
}

export class RelaySettings {
  private saving = false

  constructor(
    private readonly settings: SettingsService,
    private readonly cipher: RelayCredentialCipher,
    private readonly probe: RelayProbe = probeRelay,
  ) {}

  private stored() {
    const saved = savedSchema.safeParse(this.settings.get(key))
    return saved.success ? saved.data : undefined
  }

  view(): RelaySettingsView {
    const saved = this.stored()
    return { address: saved?.address ?? null, tokenConfigured: saved !== undefined }
  }

  async testAndSave(input: RelayTestAndSaveParams): Promise<RelayTestResult> {
    const address = relayAddress(input.address)
    if (!address) return { status: "invalid-address" }
    if (this.saving) return { status: "busy" }

    this.saving = true
    try {
      const saved = this.stored()
      const reusable = saved?.address === address ? saved : undefined
      const replacement = input.token?.trim()
      const token = replacement || (reusable ? await this.cipher.open(reusable.sealedToken) : "")
      if (!token) return { status: "token-required" }
      const result = await this.probe(address, token)
      if (result !== "ok") return { status: result }

      const sealedToken =
        reusable && !replacement ? reusable.sealedToken : await this.cipher.seal(token)
      this.settings.set(key, { address, sealedToken })
      return { status: "saved", settings: this.view() }
    } catch {
      return { status: "storage-unavailable" }
    } finally {
      this.saving = false
    }
  }
}
