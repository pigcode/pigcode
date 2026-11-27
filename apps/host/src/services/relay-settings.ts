import { randomUUID } from "node:crypto"
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
const savedSchema = z.object({
  address: z.string(),
  sealedToken: z.string().min(1),
  revision: z.uuid().optional(),
})

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
  private generation = 0

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

  /** 清空已保存的中继连接配置，使连接监听者主动断开中继。 */
  clear(): RelaySettingsView {
    this.generation += 1
    this.settings.set(key, undefined)
    return this.view()
  }

  get revision(): string | undefined {
    return this.stored()?.revision
  }

  async connectionConfig() {
    const saved = this.stored()
    if (!saved) return undefined
    return { address: saved.address, token: await this.cipher.open(saved.sealedToken) }
  }

  onConnectionChange(listener: () => void) {
    let previous = this.stored()
    return this.settings.onChange((setting) => {
      if (setting !== key) return
      const current = this.stored()
      const changed =
        previous?.address !== current?.address || previous?.sealedToken !== current?.sealedToken
      previous = current
      if (changed) listener()
    })
  }

  async testAndSave(input: RelayTestAndSaveParams): Promise<RelayTestResult> {
    const address = relayAddress(input.address)
    if (!address) return { status: "invalid-address" }
    if (this.saving) return { status: "busy" }

    this.saving = true
    const startGeneration = this.generation
    try {
      const saved = this.stored()
      const reusable = saved?.address === address ? saved : undefined
      const replacement = input.token?.trim()
      const token = replacement || (reusable ? await this.cipher.open(reusable.sealedToken) : "")
      if (!token) return { status: "token-required" }
      const result = await this.probe(address, token)
      if (this.generation !== startGeneration) return { status: "busy" }
      if (result !== "ok") return { status: result }

      if (
        reusable &&
        (!replacement ||
          (await this.cipher.open(reusable.sealedToken).catch(() => undefined)) === token)
      ) {
        if (this.generation !== startGeneration) return { status: "busy" }
        return { status: "saved", settings: this.view() }
      }

      const sealedToken = await this.cipher.seal(token)
      if (this.generation !== startGeneration) return { status: "busy" }
      this.settings.set(key, { address, sealedToken, revision: randomUUID() })
      return { status: "saved", settings: this.view() }
    } catch {
      return { status: "storage-unavailable" }
    } finally {
      this.saving = false
    }
  }
}
