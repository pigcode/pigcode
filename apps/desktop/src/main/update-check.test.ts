/** 验证版本比较与 Release 解析：草稿不算新版本，预发布按偏好取舍。 */
import { describe, expect, it, vi } from "vitest"
import {
  fetchLatestRelease,
  isNewer,
  parseVersion,
  pickRelease,
  readLatestRelease,
} from "./update-check"

describe("version comparison", () => {
  it("compares numeric parts, not strings", () => {
    expect(isNewer("1.0.0", "0.10.0")).toBe(true)
    expect(isNewer("0.9.9", "0.10.0")).toBe(false)
    expect(isNewer("1.0.0", "1.0.0")).toBe(false)
    expect(parseVersion("v1.2.3")).toEqual({ parts: [1, 2, 3], prerelease: null })
  })

  it("refuses junk", () => {
    expect(isNewer("latest", "0.1.0")).toBe(false)
    expect(isNewer("1.0.0", "not-a-version")).toBe(false)
    expect(parseVersion("1.0")).toBeNull()
  })

  // 装 beta 的人要能收到下一个 beta；发正式版时他要能回到正式线。
  it("orders prereleases by semver, below the matching release", () => {
    expect(isNewer("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true)
    // 数字段按数值比，不是按字典序。
    expect(isNewer("1.0.0-beta.10", "1.0.0-beta.9")).toBe(true)
    expect(isNewer("1.0.0", "1.0.0-beta.2")).toBe(true)
    expect(isNewer("1.0.0-beta.2", "1.0.0")).toBe(false)
    expect(isNewer("1.0.0-beta", "1.0.0-beta.1")).toBe(false)
    expect(isNewer("1.0.0-alpha", "1.0.0-beta")).toBe(false)
    // 主版本不同时，预发布后缀不参与比较。
    expect(isNewer("1.0.0-beta.1", "0.9.0")).toBe(true)
  })
})

describe("latest release", () => {
  const release = {
    tag_name: "v0.2.0",
    html_url: "https://github.com/pigcode/pigcode/releases/tag/v0.2.0",
  }

  it("reads the tag and page", () => {
    expect(readLatestRelease(release)).toEqual({
      version: "0.2.0",
      url: "https://github.com/pigcode/pigcode/releases/tag/v0.2.0",
    })
  })

  it("keeps the prerelease suffix in the version", () => {
    expect(readLatestRelease({ ...release, tag_name: "v0.2.0-beta.1" })?.version).toBe(
      "0.2.0-beta.1",
    )
  })

  it("always ignores drafts and broken responses", () => {
    expect(readLatestRelease({ ...release, draft: true })).toBeNull()
    expect(readLatestRelease({ ...release, tag_name: "nightly" })).toBeNull()
    expect(readLatestRelease({ ...release, html_url: "file:///etc/passwd" })).toBeNull()
    expect(readLatestRelease(null)).toBeNull()
  })

  // 默认不接 beta：正式版用户不该被推到预发布上。
  it("skips prereleases unless they are allowed", () => {
    const beta = { ...release, tag_name: "v0.3.0-beta.1", prerelease: true }
    expect(readLatestRelease(beta)).toBeNull()
    expect(readLatestRelease(beta, { allowPrerelease: true })?.version).toBe("0.3.0-beta.1")
  })
})

describe("picking from the release list", () => {
  const stable = {
    tag_name: "v0.2.0",
    html_url: "https://github.com/pigcode/pigcode/releases/tag/v0.2.0",
  }
  const beta = {
    tag_name: "v0.3.0-beta.1",
    html_url: "https://github.com/pigcode/pigcode/releases/tag/v0.3.0-beta.1",
    prerelease: true,
  }
  const draft = { ...stable, tag_name: "v0.9.0", draft: true }

  it("takes the newest entry that the preference allows", () => {
    // 列表按时间倒序：最新是 beta，后面才是正式版。
    expect(pickRelease([beta, stable])?.version).toBe("0.2.0")
    expect(pickRelease([beta, stable], { allowPrerelease: true })?.version).toBe("0.3.0-beta.1")
  })

  it("skips drafts but keeps looking", () => {
    expect(pickRelease([draft, stable])?.version).toBe("0.2.0")
    expect(pickRelease([draft])).toBeNull()
  })

  it("returns null when nothing usable is there", () => {
    expect(pickRelease([])).toBeNull()
    expect(pickRelease({ not: "an array" })).toBeNull()
  })
})

describe("fetching", () => {
  const release = {
    tag_name: "v0.2.0",
    html_url: "https://github.com/pigcode/pigcode/releases/tag/v0.2.0",
  }

  it("treats network failures and timeouts as 'no release'", async () => {
    const failed = vi.fn(async () => new Response("not found", { status: 404 }))
    expect(await fetchLatestRelease("http://localhost/releases", failed)).toBeNull()
    const throwing = vi.fn(async () => {
      throw new Error("offline")
    })
    expect(await fetchLatestRelease("http://localhost/releases", throwing)).toBeNull()
  })

  it("picks from the list the API returns", async () => {
    const ok = vi.fn(async () => Response.json([release]))
    expect(await fetchLatestRelease("http://localhost/releases", ok)).toEqual({
      version: "0.2.0",
      url: release.html_url,
    })
  })
})
