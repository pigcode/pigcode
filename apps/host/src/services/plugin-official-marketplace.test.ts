import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  OFFICIAL_MARKETPLACE_BASE,
  OFFICIAL_MARKETPLACE_ID,
  OFFICIAL_MARKETPLACE_NAME,
  OFFICIAL_MARKETPLACE_URL,
} from "../../../../marketplace/catalog-source"
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
  setMarketplaceEnabled,
} from "./plugin-marketplace"
import { readOfficialMarketplace, refreshOfficialMarketplace } from "./plugin-official-marketplace"
import { installFromMarketplace, updatePlugin } from "./plugin-installer"
import { listPlugins, setPluginEnabled } from "./plugin-manager"
import type { SourceIo } from "./plugin-sources"
import { tarGz } from "./tar-fixture"

const dirs: string[] = []
async function profile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-official-catalog-"))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const noGit = async () => {
  throw new Error("Git must not run")
}
const noPnpm = async () => {
  throw new Error("pnpm must not run")
}

function release(version: string, packageVersion = version) {
  const name = "@pigcode/catalog-fixture"
  const archive = tarGz([
    {
      name: "package/package.json",
      content: JSON.stringify({
        name,
        version: packageVersion,
        type: "module",
        pigcode: { apiVersion: 1, kind: "ui", client: "./client.js" },
      }),
    },
    { name: "package/client.js", content: "export function apply() {}\n" },
  ])
  const url = `${OFFICIAL_MARKETPLACE_BASE}/packages/pigcode-catalog-fixture-${version}.tgz`
  const catalogue = {
    name: OFFICIAL_MARKETPLACE_NAME,
    plugins: [
      {
        name,
        version,
        publisherType: "official",
        source: { source: "url", url, sha256: createHash("sha256").update(archive).digest("hex") },
      },
    ],
  }
  const io: SourceIo = {
    runGit: noGit,
    fetcher: vi.fn(async (location) => {
      if (location === OFFICIAL_MARKETPLACE_URL) return Response.json(catalogue)
      if (location === url) return new Response(new Uint8Array(archive))
      return new Response(null, { status: 404 })
    }),
  }
  return { name, catalogue, io }
}

describe("Pigcode official marketplace", () => {
  it("has an offline catalog for both channels and keeps personal sources with the same manifest name separate", async () => {
    const dir = await profile()
    const bundled = await readOfficialMarketplace(dir)
    expect(bundled).toMatchObject({ id: OFFICIAL_MARKETPLACE_ID, official: true, enabled: true })
    expect(new Set(bundled.plugins.map((entry) => entry.publisherType))).toEqual(
      new Set(["official", "community"]),
    )
    const local = join(dir, "personal")
    await mkdir(local)
    await writeFile(
      join(local, "marketplace.json"),
      JSON.stringify({ name: OFFICIAL_MARKETPLACE_NAME, official: true, plugins: [] }),
    )
    await addMarketplace(dir, local, release("1.0.0").io)
    const [personal] = await listMarketplaces(dir)
    expect(personal).toMatchObject({ id: OFFICIAL_MARKETPLACE_NAME })
    expect(personal?.official).toBeUndefined()
    await expect(setMarketplaceEnabled(dir, OFFICIAL_MARKETPLACE_ID, false)).rejects.toThrow(
      "MARKETPLACE_OFFICIAL",
    )
    await expect(removeMarketplace(dir, OFFICIAL_MARKETPLACE_ID)).rejects.toThrow(
      "MARKETPLACE_OFFICIAL",
    )
  })

  it("installs and updates a pinned package, preserving its disabled state", async () => {
    const dir = await profile()
    const first = release("1.0.0")
    await refreshOfficialMarketplace(dir, first.io)
    const installed = await installFromMarketplace(
      dir,
      OFFICIAL_MARKETPLACE_ID,
      first.name,
      noPnpm,
      first.io,
    )
    expect(installed.origin).toEqual({
      kind: "marketplace",
      marketplace: OFFICIAL_MARKETPLACE_ID,
      plugin: first.name,
    })
    await setPluginEnabled(dir, installed.id, false)
    const second = release("1.1.0")
    await updatePlugin(dir, installed.id, noPnpm, second.io)
    expect(await listPlugins(dir)).toMatchObject([{ version: "1.1.0", enabled: false }])
    await expect(
      updatePlugin(dir, installed.id, noPnpm, release("1.2.0", "1.0.0").io),
    ).rejects.toThrow("PLUGIN_VERSION_MISMATCH")
    expect(await listPlugins(dir)).toMatchObject([{ version: "1.1.0", enabled: false }])
  })

  it("shares simultaneous refreshes and keeps the last good catalog when a refresh is invalid", async () => {
    const dir = await profile()
    const good = release("1.0.0")
    await Promise.all([
      refreshOfficialMarketplace(dir, good.io),
      refreshOfficialMarketplace(dir, good.io, true),
    ])
    await refreshOfficialMarketplace(dir, good.io, true)
    expect(good.io.fetcher).toHaveBeenCalledTimes(1)
    const invalid = release("1.1.0").catalogue
    invalid.plugins[0]!.source.sha256 = "invalid"
    const result = await refreshOfficialMarketplace(dir, {
      runGit: noGit,
      fetcher: async () => Response.json(invalid),
    })
    expect(result.error).toContain("MARKETPLACE_INVALID")
    expect((await readOfficialMarketplace(dir)).plugins).toMatchObject([{ version: "1.0.0" }])
  })
})
