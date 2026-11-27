/**
 * 本机凭据加密器：脱离操作系统钥匙串，桌面端与无窗口 Host 共用同一实现。
 * 优先级：环境变量 `PIGCODE_CREDENTIAL_KEY`（32 字节 hex 或 base64/base64url）>
 * `<profileDir>/credential.key`（`O_CREAT | O_EXCL` + `0o600` 自动生成并持久化）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import type { RelayCredentialCipher } from "./relay-settings"

export const LOCAL_CREDENTIAL_KEY_ENV = "PIGCODE_CREDENTIAL_KEY"
export const CREDENTIAL_KEY_FILENAME = "credential.key"
export const LOCAL_CREDENTIAL_PREFIX = "local:v1:"

const CREDENTIAL_AAD = Buffer.from("pigcode.credential.v1", "utf8")
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/
const KEY_B64_RE = /^[A-Za-z0-9+/_-]{43,44}=*$/

function parseMasterKey(raw: string, source: string): Buffer {
  const trimmed = raw.trim()
  if (KEY_HEX_RE.test(trimmed)) {
    return Buffer.from(trimmed, "hex")
  }
  if (KEY_B64_RE.test(trimmed)) {
    const normalized = trimmed.replace(/-/g, "+").replace(/_/g, "/")
    const decoded = Buffer.from(normalized, "base64")
    if (decoded.length === KEY_BYTES) {
      return decoded
    }
  }
  throw new Error(`${source} must encode a 32-byte key in hex or base64/base64url`)
}

function readOrCreateFileKey(profileDir: string): Buffer {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") {
    chmodSync(profileDir, 0o700)
  }
  const keyPath = join(profileDir, CREDENTIAL_KEY_FILENAME)
  try {
    return parseMasterKey(readFileSync(keyPath, "utf8"), CREDENTIAL_KEY_FILENAME)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const generated = randomBytes(KEY_BYTES)
  try {
    const fd = openSync(keyPath, "wx", 0o600)
    try {
      writeSync(fd, `${generated.toString("hex")}\n`)
    } finally {
      closeSync(fd)
    }
    return generated
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return parseMasterKey(readFileSync(keyPath, "utf8"), CREDENTIAL_KEY_FILENAME)
    }
    throw error
  }
}

export function resolveLocalCredentialKey(
  profileDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Buffer {
  const fromEnv = env[LOCAL_CREDENTIAL_KEY_ENV]
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return parseMasterKey(fromEnv, LOCAL_CREDENTIAL_KEY_ENV)
  }
  return readOrCreateFileKey(profileDir)
}

export function createLocalCredentialCipher(
  profileDir: string,
  env: NodeJS.ProcessEnv = process.env,
): RelayCredentialCipher {
  let cachedKey: Buffer | undefined
  const getKey = (): Buffer => {
    cachedKey ??= resolveLocalCredentialKey(profileDir, env)
    return cachedKey
  }

  return {
    async seal(value: string): Promise<string> {
      const key = getKey()
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      cipher.setAAD(CREDENTIAL_AAD)
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
      const tag = cipher.getAuthTag()
      return `${LOCAL_CREDENTIAL_PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`
    },

    async open(value: string): Promise<string> {
      if (!value.startsWith(LOCAL_CREDENTIAL_PREFIX)) {
        throw new Error("Unsupported or legacy credential format (expected local:v1)")
      }
      const rest = value.slice(LOCAL_CREDENTIAL_PREFIX.length)
      const segments = rest.split(":")
      if (segments.length !== 3) {
        throw new Error("Malformed local credential envelope")
      }
      const [ivB64, tagB64, dataB64] = segments as [string, string, string]
      const iv = Buffer.from(ivB64, "base64url")
      const tag = Buffer.from(tagB64, "base64url")
      const ciphertext = Buffer.from(dataB64, "base64url")
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new Error("Malformed local credential metadata lengths")
      }
      const key = getKey()
      const decipher = createDecipheriv("aes-256-gcm", key, iv)
      decipher.setAAD(CREDENTIAL_AAD)
      decipher.setAuthTag(tag)
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
      return plaintext.toString("utf8")
    },
  }
}
