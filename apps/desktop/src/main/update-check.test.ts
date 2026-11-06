/** 验证版本比较与 Release 解析：预发布、草稿、坏数据都不算新版本。 */
import { describe, expect, it, vi } from "vitest"
import { fetchLatestRelease, isNewer, parseVersion, readLatestRelease } from "./update-check"

describe("version comparison", () => {
  it("compares numeric parts, not strings", () => {
    expect(isNewer("1.0.0", "0.10.0")).toBe(true)
    expect(isNewer("0.9.9", "0.10.0")).toBe(false)
    expect(isNewer("1.0.0", "1.0.0")).toBe(false)
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3])
  })

  it("refuses to compare prereleases or junk", () => {
    expect(parseVersion("1.0.0-beta.1")).toBeNull()
    expect(isNewer("1.0.0-beta.1", "0.1.0")).toBe(false)
    expect(isNewer("latest", "0.1.0")).toBe(false)
    expect(isNewer("1.0.0", "not-a-version")).toBe(false)
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

  it("ignores drafts, prereleases and broken responses", () => {
    expect(readLatestRelease({ ...release, draft: true })).toBeNull()
    expect(readLatestRelease({ ...release, prerelease: true })).toBeNull()
    expect(readLatestRelease({ ...release, tag_name: "nightly" })).toBeNull()
    expect(readLatestRelease({ ...release, html_url: "file:///etc/passwd" })).toBeNull()
    expect(readLatestRelease(null)).toBeNull()
  })

  it("treats network failures and timeouts as 'no release'", async () => {
    const failed = vi.fn(async () => new Response("not found", { status: 404 }))
    expect(await fetchLatestRelease("http://localhost/latest", failed)).toBeNull()
    const throwing = vi.fn(async () => {
      throw new Error("offline")
    })
    expect(await fetchLatestRelease("http://localhost/latest", throwing)).toBeNull()
    const ok = vi.fn(async () => Response.json(release))
    expect(await fetchLatestRelease("http://localhost/latest", ok)).toEqual({
      version: "0.2.0",
      url: release.html_url,
    })
  })
})
