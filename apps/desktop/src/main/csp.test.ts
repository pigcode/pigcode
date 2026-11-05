/** 验证 CSP：内联脚本按哈希放行，界面需要的资源类型都列出来。 */
import { describe, expect, it } from "vitest"
import { contentSecurityPolicy, inlineScriptHashes } from "./csp"

const HASH = /^'sha256-[A-Za-z0-9+/]+=*'$/

describe("inline script hashes", () => {
  it("hashes only inline script bodies, keeping their whitespace", () => {
    const html = `<script type="importmap">{"imports":{}}</script>
<script type="module" src="./main.js"></script>
<script data-src="x">a</script>
<script>  spaced  </script>`
    const hashes = inlineScriptHashes(html)
    expect(hashes).toHaveLength(3)
    for (const hash of hashes) expect(hash).toMatch(HASH)
  })

  it("changes when the import map changes", () => {
    const before = inlineScriptHashes('<script type="importmap">{"a":1}</script>')
    const after = inlineScriptHashes('<script type="importmap">{"a":2}</script>')
    expect(before).not.toEqual(after)
  })

  it("has nothing to hash in a page without inline scripts", () => {
    expect(inlineScriptHashes('<script src="./main.js"></script>')).toEqual([])
  })
})

describe("content security policy", () => {
  const csp = contentSecurityPolicy('<script type="importmap">{"imports":{}}</script>')

  it("allows the app's own resources and the inline import map only", () => {
    expect(csp).toContain("default-src 'self'")
    expect(csp).toMatch(/script-src 'self' pigcode-plugin: 'sha256-/)
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
    expect(csp).toContain("style-src 'self' 'unsafe-inline' pigcode-plugin:")
    expect(csp).toContain("img-src 'self' data:")
    expect(csp).toContain("connect-src 'self' pigcode-plugin:")
    expect(csp).toContain("object-src 'none'")
  })

  it("lets the browser panel and preview frames load pages", () => {
    expect(csp).toContain("frame-src 'self' blob: http: https:")
  })
})
