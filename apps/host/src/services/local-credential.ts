/**
 * 本机凭据加密器：脱离操作系统钥匙串，桌面端与无窗口 Host 共用同一实现。
 * 优先级：环境变量 `PIGCODE_CREDENTIAL_KEY`（32 字节 hex 或 base64/base64url）>
 * `<profileDir>/credential.key`（临时文件写入 + fsync + `linkSync` 原子落盘，`0o600`）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmodSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { ensureProfileDir } from "../kernel/profile-paths"
import { writePrivateFileExclusive } from "./atomic-write"
import type { RelayCredentialCipher } from "./relay-settings"

export const LOCAL_CREDENTIAL_KEY_ENV = "PIGCODE_CREDENTIAL_KEY"
export const CREDENTIAL_KEY_FILENAME = "credential.key"
export const LOCAL_CREDENTIAL_PREFIX = "local:v1:"

const CREDENTIAL_AAD = Buffer.from("pigcode.credential.v1", "utf8")
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/
const KEY_STD_B64_RE = /^[A-Za-z0-9+/]{43}=?$/
const KEY_URL_B64_RE = /^[A-Za-z0-9_-]{43}=?$/
const BASE64URL_NON_EMPTY_RE = /^[A-Za-z0-9_-]+$/
const BASE64URL_MAYBE_EMPTY_RE = /^[A-Za-z0-9_-]*$/

function parseMasterKey(raw: string, source: string): Buffer {
  const trimmed = raw.trim()
  if (KEY_HEX_RE.test(trimmed)) {
    return Buffer.from(trimmed, "hex")
  }
  if (KEY_STD_B64_RE.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64")
    if (decoded.length === KEY_BYTES) {
      return decoded
    }
  }
  if (KEY_URL_B64_RE.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64url")
    if (decoded.length === KEY_BYTES) {
      return decoded
    }
  }
  throw new Error(`${source} must encode a 32-byte key in hex or base64/base64url`)
}

function decodeStrictBase64Url(segment: string, allowEmpty: boolean, label: string): Buffer {
  const pattern = allowEmpty ? BASE64URL_MAYBE_EMPTY_RE : BASE64URL_NON_EMPTY_RE
  if (!pattern.test(segment)) {
    throw new Error(`Malformed local credential ${label}`)
  }
  const decoded = Buffer.from(segment, "base64url")
  if (decoded.toString("base64url") !== segment) {
    throw new Error(`Non-canonical local credential ${label}`)
  }
  return decoded
}

function tightenFilePermissions(keyPath: string): void {
  if (process.platform === "win32") return
  try {
    const mode = statSync(keyPath).mode & 0o777
    if ((mode & 0o077) !== 0) {
      chmodSync(keyPath, 0o600)
    }
  } catch {
    // 最佳努力收紧权限：外部只读挂载或非属主文件等情况不阻塞读取
  }
}

function readExistingFileKey(keyPath: string): Buffer {
  const raw = readFileSync(keyPath, "utf8")
  tightenFilePermissions(keyPath)
  return parseMasterKey(raw, CREDENTIAL_KEY_FILENAME)
}

function readOrCreateFileKey(profileDir: string): Buffer {
  ensureProfileDir(profileDir)
  const keyPath = join(profileDir, CREDENTIAL_KEY_FILENAME)
  try {
    return readExistingFileKey(keyPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  const generated = randomBytes(KEY_BYTES)
  if (writePrivateFileExclusive(keyPath, `${generated.toString("hex")}\n`)) {
    return generated
  }
  return readExistingFileKey(keyPath)
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
      const iv = decodeStrictBase64Url(ivB64, false, "iv")
      const tag = decodeStrictBase64Url(tagB64, false, "tag")
      const ciphertext = decodeStrictBase64Url(dataB64, true, "ciphertext")
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
