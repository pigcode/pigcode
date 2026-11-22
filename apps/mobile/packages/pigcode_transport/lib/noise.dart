// Noise IK state machine. Cryptographic primitives come from cryptography.
import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

final _suite = utf8.encode('Noise_IK_25519_ChaChaPoly_SHA256');
final _mobilePrologue = utf8.encode('pigcode-mobile-v1');
final _checkLabel = utf8.encode('pigcode-pairing-check-v1');
final _x25519 = X25519();
final _sha256 = Sha256();
final _hmac = Hmac.sha256();
final _chacha = Chacha20.poly1305Aead();
const _tagLength = 16;

class NoiseIdentity {
  NoiseIdentity._(this._keyPair, this.publicKey, this.seed);

  final SimpleKeyPair _keyPair;
  final Uint8List publicKey;
  final Uint8List seed;

  static Future<NoiseIdentity> create([List<int>? seed]) async {
    final key = seed == null
        ? await _x25519.newKeyPair()
        : await _x25519.newKeyPairFromSeed(seed);
    return NoiseIdentity._(
      key,
      Uint8List.fromList((await key.extractPublicKey()).bytes),
      Uint8List.fromList(await key.extractPrivateKeyBytes()),
    );
  }

  Future<List<int>> _dh(List<int> peer) async {
    if (peer.length != 32) throw const FormatException('Invalid Noise key');
    final secret = await _x25519.sharedSecretKey(
      keyPair: _keyPair,
      remotePublicKey: SimplePublicKey(peer, type: KeyPairType.x25519),
    );
    final shared = await secret.extractBytes();
    if (shared.every((byte) => byte == 0)) {
      throw const FormatException('Invalid Noise shared secret');
    }
    return shared;
  }
}

Future<(List<int>, List<int>)> _derive(
  List<int> chain,
  List<int> material,
) async {
  final intermediate = await _hmac.calculateMac(
    material,
    secretKey: SecretKey(chain),
  );
  final secret = SecretKey(intermediate.bytes);
  final first = (await _hmac.calculateMac([1], secretKey: secret)).bytes;
  final second = (await _hmac.calculateMac([
    ...first,
    2,
  ], secretKey: secret)).bytes;
  return (first, second);
}

class _Cipher {
  _Cipher(List<int> key) : _key = SecretKey(key);

  final SecretKey _key;
  int _sequence = 0;

  Uint8List _nextNonce() {
    if (_sequence == 0x7fffffffffffffff) {
      throw const FormatException('Noise nonce exhausted');
    }
    return (ByteData(
      12,
    )..setUint64(4, _sequence++, Endian.little)).buffer.asUint8List();
  }

  Future<Uint8List> encrypt(
    List<int> message, [
    List<int> aad = const [],
  ]) async {
    if (message.length + _tagLength > 65535) {
      throw const FormatException('Oversized Noise message');
    }
    final box = await _chacha.encrypt(
      message,
      secretKey: _key,
      nonce: _nextNonce(),
      aad: aad,
    );
    return Uint8List.fromList([...box.cipherText, ...box.mac.bytes]);
  }

  Future<Uint8List> decrypt(
    List<int> message, [
    List<int> aad = const [],
  ]) async {
    if (message.length < _tagLength || message.length > 65535) {
      throw const FormatException('Invalid Noise message');
    }
    final bodyLength = message.length - _tagLength;
    final clear = await _chacha.decrypt(
      SecretBox(
        message.sublist(0, bodyLength),
        nonce: _nextNonce(),
        mac: Mac(message.sublist(bodyLength)),
      ),
      secretKey: _key,
      aad: aad,
    );
    return Uint8List.fromList(clear);
  }
}

class NoiseSession {
  NoiseSession._(this.verificationCode, this._outbound, this._inbound);

  final String verificationCode;
  final _Cipher _outbound;
  final _Cipher _inbound;

  Future<Uint8List> encrypt(List<int> bytes) => _outbound.encrypt(bytes);
  Future<Uint8List> decrypt(List<int> bytes) => _inbound.decrypt(bytes);
}

class _Handshake {
  _Handshake(List<int> initial) : _digest = initial, _chain = initial;

  List<int> _digest;
  List<int> _chain;
  late _Cipher _cipher;

  Future<void> mixHash(List<int> data) async {
    _digest = (await _sha256.hash([..._digest, ...data])).bytes;
  }

  Future<void> mixKey(List<int> material) async {
    final (chain, key) = await _derive(_chain, material);
    _chain = chain;
    _cipher = _Cipher(key);
  }

  Future<Uint8List> seal(List<int> data) async {
    final bytes = await _cipher.encrypt(data, _digest);
    await mixHash(bytes);
    return bytes;
  }

  Future<Uint8List> open(List<int> data) async {
    final clear = await _cipher.decrypt(data, _digest);
    await mixHash(data);
    return clear;
  }

  Future<NoiseSession> split() async {
    final (outbound, inbound) = await _derive(_chain, const []);
    final output = (await _sha256.hash([..._checkLabel, ..._digest])).bytes;
    final value = ByteData.sublistView(Uint8List.fromList(output)).getUint32(0);
    final code = (value % 1000000).toString().padLeft(6, '0');
    return NoiseSession._(code, _Cipher(outbound), _Cipher(inbound));
  }
}

class NoiseInitiation {
  NoiseInitiation._(this.message, this._state, this._identity, this._ephemeral);

  final Uint8List message;
  final _Handshake _state;
  final NoiseIdentity _identity;
  final NoiseIdentity _ephemeral;
  bool _used = false;

  static Future<NoiseInitiation> start(
    NoiseIdentity identity,
    List<int> hostKey,
    List<int> payload, {
    List<int>? prologue,
    NoiseIdentity? ephemeral,
  }) async {
    final state = _Handshake(_suite);
    final local = ephemeral ?? await NoiseIdentity.create();
    await state.mixHash(prologue ?? _mobilePrologue);
    await state.mixHash(hostKey);
    await state.mixHash(local.publicKey);
    await state.mixKey(await local._dh(hostKey));
    final encryptedIdentity = await state.seal(identity.publicKey);
    await state.mixKey(await identity._dh(hostKey));
    final message = Uint8List.fromList([
      ...local.publicKey,
      ...encryptedIdentity,
      ...await state.seal(payload),
    ]);
    return NoiseInitiation._(message, state, identity, local);
  }

  Future<({Uint8List payload, NoiseSession session})> finish(
    List<int> message,
  ) async {
    if (_used || message.length < 48) {
      throw const FormatException('Invalid Noise IK response');
    }
    _used = true;
    final remote = message.sublist(0, 32);
    await _state.mixHash(remote);
    await _state.mixKey(await _ephemeral._dh(remote));
    await _state.mixKey(await _identity._dh(remote));
    final payload = await _state.open(message.sublist(32));
    return (payload: payload, session: await _state.split());
  }
}
