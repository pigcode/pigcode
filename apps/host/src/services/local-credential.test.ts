import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  CREDENTIAL_KEY_FILENAME,
  LOCAL_CREDENTIAL_KEY_ENV,
  LOCAL_CREDENTIAL_PREFIX,
  createLocalCredentialCipher,
} from "./local-credential"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pigcode-local-cred-"))
  dirs.push(dir)
  return dir
}

describe("createLocalCredentialCipher", () => {
  it("creates a 0600 credential.key file and seals/opens secrets across instances", async () => {
    const profileDir = await makeTempDir()
    const cipherA = createLocalCredentialCipher(profileDir, {})

    const sealed = await cipherA.seal("relay-secret-token")
    expect(sealed.startsWith(LOCAL_CREDENTIAL_PREFIX)).toBe(true)
    expect(sealed).not.toContain("relay-secret-token")

    const keyPath = join(profileDir, CREDENTIAL_KEY_FILENAME)
    const keyHex = (await readFile(keyPath, "utf8")).trim()
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== "win32") {
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
    }

    const cipherB = createLocalCredentialCipher(profileDir, {})
    expect(await cipherB.open(sealed)).toBe("relay-secret-token")
  })

  it("supports PIGCODE_CREDENTIAL_KEY in hex or base64url without writing credential.key", async () => {
    const profileDir = await makeTempDir()
    const hexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    const cipherHex = createLocalCredentialCipher(profileDir, { [LOCAL_CREDENTIAL_KEY_ENV]: hexKey })

    const sealed = await cipherHex.seal("apns-token-xyz")
    await expect(readFile(join(profileDir, CREDENTIAL_KEY_FILENAME), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    })

    const b64uKey = Buffer.from(hexKey, "hex").toString("base64url")
    const cipherB64 = createLocalCredentialCipher(profileDir, {
      [LOCAL_CREDENTIAL_KEY_ENV]: b64uKey,
    })
    expect(await cipherB64.open(sealed)).toBe("apns-token-xyz")
  })

  it("rejects malformed PIGCODE_CREDENTIAL_KEY", async () => {
    const profileDir = await makeTempDir()
    const cipher = createLocalCredentialCipher(profileDir, {
      [LOCAL_CREDENTIAL_KEY_ENV]: "too-short",
    })
    await expect(cipher.seal("secret")).rejects.toThrow(/PIGCODE_CREDENTIAL_KEY/i)
  })

  it("rejects tampered ciphertext, wrong profile key, and legacy safeStorage payloads", async () => {
    const profileA = await makeTempDir()
    const profileB = await makeTempDir()
    const cipherA = createLocalCredentialCipher(profileA, {})
    const cipherB = createLocalCredentialCipher(profileB, {})

    const sealed = await cipherA.seal("seed-value")
    const parts = sealed.split(":")
    const last = parts[parts.length - 1]!
    const flipped = `${last.slice(0, -1)}${last.endsWith("A") ? "B" : "A"}`
    const tampered = [...parts.slice(0, -1), flipped].join(":")

    await expect(cipherA.open(tampered)).rejects.toThrow()
    await expect(cipherB.open(sealed)).rejects.toThrow()
    await expect(cipherA.open("AQIDBAUGBwg=")).rejects.toThrow()
  })

  it("handles concurrent first-time initialization without overwriting key", async () => {
    const parent = await makeTempDir()
    const profileDir = join(parent, "nested")
    await mkdir(profileDir, { recursive: true })
    await chmod(profileDir, 0o700)

    const c1 = createLocalCredentialCipher(profileDir, {})
    const c2 = createLocalCredentialCipher(profileDir, {})
    const [s1, s2] = await Promise.all([c1.seal("alpha"), c2.seal("beta")])

    expect(await c1.open(s2)).toBe("beta")
    expect(await c2.open(s1)).toBe("alpha")
  })

  it("rejects corrupted credential.key files", async () => {
    const profileDir = await makeTempDir()
    await writeFile(join(profileDir, CREDENTIAL_KEY_FILENAME), "not-a-key\n", { mode: 0o600 })
    const cipher = createLocalCredentialCipher(profileDir, {})
    await expect(cipher.seal("secret")).rejects.toThrow(/credential\.key/i)
  })
})
