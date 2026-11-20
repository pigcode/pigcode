import { z } from "zod"
import {
  acpRegistryAgentIdSchema,
  cliArgumentsSchema,
  type AcpRegistryEntry,
} from "@pigcode/contracts"
import { findExecutable } from "@pigcode/plugin-sdk/node"

const registryUrl = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"
const version = z.string().max(128).min(1)
export const launchDefaults = {
  args: cliArgumentsSchema.optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
}
const binaryDistribution = z.object({
  ...launchDefaults,
  archive: z.url({ protocol: /^https$/ }),
  cmd: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
})
const packageDistribution = z.object({ ...launchDefaults, package: z.string().max(512) })
const webLink = z
  .url({ protocol: /^https$/ })
  .optional()
  .catch(undefined)
const agentEntry = z.object({
  id: acpRegistryAgentIdSchema,
  name: z.string().min(1).max(160),
  version,
  description: z.string().max(1024),
  license: z.string().max(160).optional(),
  icon: webLink,
  website: webLink,
  repository: webLink,
  distribution: z.object({
    binary: z.record(z.string(), binaryDistribution).optional(),
    npx: packageDistribution.optional(),
    uvx: packageDistribution.optional(),
  }),
})
type Binary = z.infer<typeof binaryDistribution>
type Package = z.infer<typeof packageDistribution>

export type Entry = { metadata: AcpRegistryEntry; source: Binary | Package }
function asEntry(raw: unknown): Entry | undefined {
  const value = agentEntry.safeParse(raw)
  if (!value.success) return undefined
  const { distribution, license, icon, website, repository, ...agent } = value.data
  const os = process.platform === "win32" ? "windows" : process.platform
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch
  const binary = distribution.binary?.[`${os}-${arch}`]
  const source = binary ?? distribution.npx ?? distribution.uvx
  if (!source) return undefined
  return {
    metadata: {
      ...agent,
      ...(license ? { license } : {}),
      ...(icon?.startsWith("https://cdn.agentclientprotocol.com/registry/") ? { icon } : {}),
      ...(website ? { website } : {}),
      ...(repository ? { repository } : {}),
      distribution: binary ? "binary" : distribution.npx ? "npx" : "uvx",
    },
    source,
  }
}

export class RegistryCatalog {
  private last?: Map<string, Entry>
  private deadline = 0
  private pending?: Promise<Map<string, Entry>>
  constructor(private readonly fetcher: typeof fetch) {}

  private async read(): Promise<Map<string, Entry>> {
    const response = await this.fetcher(registryUrl, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error("Could not load ACP Registry")
    const { agents } = z
      .object({ agents: z.array(z.unknown()).max(2_000) })
      .parse(await response.json())
    const entries = agents.flatMap((item) => asEntry(item) ?? [])
    return new Map(entries.map((entry) => [entry.metadata.id, entry]))
  }

  private async catalog(refresh = false) {
    if (!refresh && this.last && this.deadline > Date.now()) return this.last
    this.pending ??= this.read()
      .then((items) => {
        this.last = items
        this.deadline = Date.now() + 60_000
        return items
      })
      .catch((error: unknown) => {
        if (this.last) return this.last
        throw error
      })
      .finally(() => {
        delete this.pending
      })
    return this.pending
  }

  async list(): Promise<AcpRegistryEntry[]> {
    const catalog = await this.catalog()
    const managers = { npx: findExecutable("npm"), uvx: findExecutable("uv") }
    return [...catalog.values()]
      .map((entry) => entry.metadata)
      .filter(({ distribution }) => distribution === "binary" || managers[distribution])
  }

  async get(id: string, refresh = false) {
    const entry = (await this.catalog(refresh)).get(id)
    if (!entry) throw new Error("This ACP Registry agent has no runtime for this platform")
    return entry
  }
}
