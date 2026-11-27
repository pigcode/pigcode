import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
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

  it("seals and opens empty string payloads", async () => {
    const profileDir = await makeTempDir()
    const cipher = createLocalCredentialCipher(profileDir, {})

    const sealed = await cipher.seal("")
    expect(sealed.startsWith(LOCAL_CREDENTIAL_PREFIX)).toBe(true)
    expect(await cipher.open(sealed)).toBe("")
  })

  it("supports PIGCODE_CREDENTIAL_KEY in hex, base64url, or padded standard base64 without writing credential.key", async () => {
    const profileDir = await makeTempDir()
    const hexKey = `fbefff${"01".repeat(29)}`
    const cipherHex = createLocalCredentialCipher(profileDir, {
      [LOCAL_CREDENTIAL_KEY_ENV]: hexKey,
    })

    const sealed = await cipherHex.seal("apns-token-xyz")
    await expect(readFile(join(profileDir, CREDENTIAL_KEY_FILENAME), "utf8")).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    )

    const b64uKey = Buffer.from(hexKey, "hex").toString("base64url")
    const cipherB64u = createLocalCredentialCipher(profileDir, {
      [LOCAL_CREDENTIAL_KEY_ENV]: b64uKey,
    })
    expect(await cipherB64u.open(sealed)).toBe("apns-token-xyz")

    const stdB64Key = Buffer.from(hexKey, "hex").toString("base64")
    expect(stdB64Key).toContain("+")
    expect(stdB64Key).toContain("/")
    expect(stdB64Key.endsWith("=")).toBe(true)
    const cipherStdB64 = createLocalCredentialCipher(profileDir, {
      [LOCAL_CREDENTIAL_KEY_ENV]: stdB64Key,
    })
    expect(await cipherStdB64.open(sealed)).toBe("apns-token-xyz")
  })

  it("treats whitespace-only PIGCODE_CREDENTIAL_KEY as unset and falls back to credential.key", async () => {
    const profileDir = await makeTempDir()
    const cipherEnvBlank = createLocalCredentialCipher(profileDir, {
      [LOCAL_CREDENTIAL_KEY_ENV]: "   \t\n ",
    })

    const sealed = await cipherEnvBlank.seal("fallback-secret")
    const keyHex = (await readFile(join(profileDir, CREDENTIAL_KEY_FILENAME), "utf8")).trim()
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/)

    const cipherFile = createLocalCredentialCipher(profileDir, {})
    expect(await cipherFile.open(sealed)).toBe("fallback-secret")
  })

  it("rejects malformed, mixed +/_, or multi-padded PIGCODE_CREDENTIAL_KEY", async () => {
    const profileDir = await makeTempDir()
    for (const invalid of ["too-short", `+${"_".repeat(42)}=`, `${"A".repeat(43)}======`]) {
      const cipher = createLocalCredentialCipher(profileDir, {
        [LOCAL_CREDENTIAL_KEY_ENV]: invalid,
      })
      await expect(cipher.seal("secret")).rejects.toThrow(/PIGCODE_CREDENTIAL_KEY/i)
    }
  })

  it("rejects tampered ciphertext, wrong profile key, legacy payloads, and non-base64url or non-canonical segments", async () => {
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

    const sealedEmpty = await cipherA.seal("")
    const [, , emptyIv, emptyTag] = sealedEmpty.split(":") as [string, string, string, string]
    await expect(
      cipherA.open(`${LOCAL_CREDENTIAL_PREFIX}${emptyIv}:${emptyTag}:!!!`),
    ).rejects.toThrow()

    const [, , ivB64, tagB64, dataB64] = parts as [string, string, string, string, string]
    await expect(
      cipherA.open(`${LOCAL_CREDENTIAL_PREFIX}${ivB64} :${tagB64}:${dataB64}`),
    ).rejects.toThrow()
    await expect(
      cipherA.open(`${LOCAL_CREDENTIAL_PREFIX}${ivB64}=:${tagB64}:${dataB64}`),
    ).rejects.toThrow()
    await expect(
      cipherA.open(`${LOCAL_CREDENTIAL_PREFIX}${ivB64}:${tagB64}:${dataB64}!`),
    ).rejects.toThrow()

    const b64uAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const lastTagChar = tagB64.at(-1)!
    const nonCanonicalTag = `${tagB64.slice(0, -1)}${b64uAlphabet[b64uAlphabet.indexOf(lastTagChar) ^ 1]!}`
    await expect(
      cipherA.open(`${LOCAL_CREDENTIAL_PREFIX}${ivB64}:${nonCanonicalTag}:${dataB64}`),
    ).rejects.toThrow()
  })

  it("handles concurrent first-time initialization without overwriting key or leaving temp files", async () => {
    const parent = await makeTempDir()
    const profileDir = join(parent, "nested", "profile")

    const c1 = createLocalCredentialCipher(profileDir, {})
    const c2 = createLocalCredentialCipher(profileDir, {})
    const [s1, s2] = await Promise.all([c1.seal("alpha"), c2.seal("beta")])

    expect(await c1.open(s2)).toBe("beta")
    expect(await c2.open(s1)).toBe("alpha")
    expect(await readdir(profileDir)).toEqual([CREDENTIAL_KEY_FILENAME])
    if (process.platform !== "win32") {
      expect((await stat(profileDir)).mode & 0o777).toBe(0o700)
    }
  })

  it("tightens overly permissive credential.key files on POSIX", async () => {
    if (process.platform === "win32") return
    const profileDir = await makeTempDir()
    const keyPath = join(profileDir, CREDENTIAL_KEY_FILENAME)
    const hexKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    await writeFile(keyPath, `${hexKey}\n`, { mode: 0o644 })
    await chmod(keyPath, 0o644)

    const cipher = createLocalCredentialCipher(profileDir, {})
    const sealed = await cipher.seal("secret")
    expect(await cipher.open(sealed)).toBe("secret")
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
  })

  it("rejects corrupted credential.key files", async () => {
    const profileDir = await makeTempDir()
    await writeFile(join(profileDir, CREDENTIAL_KEY_FILENAME), "not-a-key\n", { mode: 0o600 })
    const cipher = createLocalCredentialCipher(profileDir, {})
    await expect(cipher.seal("secret")).rejects.toThrow(/credential\.key/i)
  })
})
