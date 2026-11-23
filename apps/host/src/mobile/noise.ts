// Noise IK uses Node's X25519, ChaCha20-Poly1305 and SHA-256 primitives.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
  type KeyObject,
} from "node:crypto"

const suite = Buffer.from("Noise_IK_25519_ChaChaPoly_SHA256")
const mobilePrologue = Buffer.from("pigcode-mobile-v1")
const empty = Buffer.alloc(0)
const tagLength = 16
const privatePrefix = Buffer.from("302e020100300506032b656e04220420", "hex")
const publicPrefix = Buffer.from("302a300506032b656e032100", "hex")
const lastNonce = 0xffffffffffffffffn

export interface NoiseKeyPair {
  readonly seed: Buffer
  readonly publicKey: Buffer
  readonly privateKey: KeyObject
}

export function noiseKeyPair(seed = randomBytes(32)): NoiseKeyPair {
  if (seed.length !== 32) throw new Error("invalid Noise identity")
  const privateKey = createPrivateKey({
    key: Buffer.concat([privatePrefix, seed]),
    format: "der",
    type: "pkcs8",
  })
  const encoded = createPublicKey(privateKey).export({ format: "der", type: "spki" })
  return { seed, privateKey, publicKey: encoded.subarray(-32) }
}

export function x25519SharedSecret(local: NoiseKeyPair, remote: Buffer): Buffer {
  if (remote.length !== 32) throw new Error("invalid Noise public key")
  const publicKey = createPublicKey({
    key: Buffer.concat([publicPrefix, remote]),
    format: "der",
    type: "spki",
  })
  return diffieHellman({ privateKey: local.privateKey, publicKey })
}

function hash(...pieces: Buffer[]): Buffer {
  const digest = createHash("sha256")
  for (const piece of pieces) digest.update(piece)
  return digest.digest()
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest()
}

function derive(chain: Buffer, material: Buffer): [Buffer, Buffer] {
  const temporary = hmac(chain, material)
  const first = hmac(temporary, Buffer.of(1))
  return [first, hmac(temporary, Buffer.concat([first, Buffer.of(2)]))]
}

class Cipher {
  private sequence = 0n

  constructor(private readonly key: Buffer) {}

  private nonce(): Buffer {
    if (this.sequence === lastNonce) throw new Error("Noise nonce exhausted")
    const nonce = Buffer.alloc(12)
    nonce.writeBigUInt64LE(this.sequence++, 4)
    return nonce
  }

  encrypt(plain: Buffer, aad: Buffer = empty): Buffer {
    if (plain.length + tagLength > 65535) throw new Error("oversized Noise message")
    const cipher = createCipheriv("chacha20-poly1305", this.key, this.nonce(), {
      authTagLength: tagLength,
    })
    cipher.setAAD(aad, { plaintextLength: plain.length })
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  }

  decrypt(bytes: Buffer, aad: Buffer = empty): Buffer {
    if (bytes.length < tagLength || bytes.length > 65535) throw new Error("invalid Noise message")
    const cipher = createDecipheriv("chacha20-poly1305", this.key, this.nonce(), {
      authTagLength: tagLength,
    })
    cipher.setAAD(aad, { plaintextLength: bytes.length - tagLength })
    cipher.setAuthTag(bytes.subarray(-tagLength))
    return Buffer.concat([cipher.update(bytes.subarray(0, -tagLength)), cipher.final()])
  }
}

export interface NoiseSession {
  readonly verificationCode: string
  encrypt(plain: Buffer): Buffer
  decrypt(bytes: Buffer): Buffer
}

class Handshake {
  private digest =
    suite.length <= 32 ? Buffer.concat([suite, Buffer.alloc(32 - suite.length)]) : hash(suite)
  private chain = this.digest
  private cipher?: Cipher

  constructor(prologue: Buffer, hostPublicKey: Buffer) {
    this.mixHash(prologue)
    this.mixHash(hostPublicKey)
  }

  mixHash(data: Buffer): void {
    this.digest = hash(this.digest, data)
  }

  mixKey(material: Buffer): void {
    const [chain, key] = derive(this.chain, material)
    this.chain = chain
    this.cipher = new Cipher(key)
  }

  seal(data: Buffer): Buffer {
    if (!this.cipher) throw new Error("Noise payload has no key")
    const encrypted = this.cipher.encrypt(data, this.digest)
    this.mixHash(encrypted)
    return encrypted
  }

  open(data: Buffer): Buffer {
    if (!this.cipher) throw new Error("Noise payload has no key")
    const clear = this.cipher.decrypt(data, this.digest)
    this.mixHash(data)
    return clear
  }

  split(initiator: boolean): NoiseSession {
    const [first, second] = derive(this.chain, empty)
    const outbound = new Cipher(initiator ? first : second)
    const inbound = new Cipher(initiator ? second : first)
    const check = hash(Buffer.from("pigcode-pairing-check-v1"), this.digest).readUInt32BE(0)
    return {
      verificationCode: String(check % 1_000_000).padStart(6, "0"),
      encrypt: (plain) => outbound.encrypt(plain),
      decrypt: (bytes) => inbound.decrypt(bytes),
    }
  }
}

interface HandshakeOptions {
  prologue?: Buffer
  ephemeral?: NoiseKeyPair
}

export function beginNoise(
  identity: NoiseKeyPair,
  hostKey: Buffer,
  payload: Buffer,
  { prologue = mobilePrologue, ephemeral = noiseKeyPair() }: HandshakeOptions = {},
) {
  const state = new Handshake(prologue, hostKey)
  state.mixHash(ephemeral.publicKey)
  state.mixKey(x25519SharedSecret(ephemeral, hostKey))
  const encryptedIdentity = state.seal(identity.publicKey)
  state.mixKey(x25519SharedSecret(identity, hostKey))
  const message = Buffer.concat([ephemeral.publicKey, encryptedIdentity, state.seal(payload)])
  let used = false
  return {
    message,
    finish(reply: Buffer) {
      if (used || reply.length < 48) throw new Error("invalid Noise IK response")
      used = true
      const remote = reply.subarray(0, 32)
      state.mixHash(remote)
      state.mixKey(x25519SharedSecret(ephemeral, remote))
      state.mixKey(x25519SharedSecret(identity, remote))
      const payload = state.open(reply.subarray(32))
      return { payload, session: state.split(true) }
    },
  }
}

export function acceptNoise(
  identity: NoiseKeyPair,
  message: Buffer,
  { prologue = mobilePrologue, ephemeral = noiseKeyPair() }: HandshakeOptions = {},
) {
  if (message.length < 96) throw new Error("invalid Noise IK initiation")
  const state = new Handshake(prologue, identity.publicKey)
  const remote = message.subarray(0, 32)
  state.mixHash(remote)
  state.mixKey(x25519SharedSecret(identity, remote))
  const publicKey = state.open(message.subarray(32, 80))
  state.mixKey(x25519SharedSecret(identity, publicKey))
  const payload = state.open(message.subarray(80))
  let used = false
  return {
    publicKey,
    payload,
    reply(payload: Buffer = empty) {
      if (used) throw new Error("Noise IK already completed")
      used = true
      state.mixHash(ephemeral.publicKey)
      state.mixKey(x25519SharedSecret(ephemeral, remote))
      state.mixKey(x25519SharedSecret(ephemeral, publicKey))
      return {
        message: Buffer.concat([ephemeral.publicKey, state.seal(payload)]),
        session: state.split(false),
      }
    },
  }
}
