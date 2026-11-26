import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'noise.dart';
export 'noise.dart' show NoiseIdentity;

const relayProtocolVersion = 1;
final _keyEncoding = RegExp(r'^[A-Za-z0-9_-]{43}$');

class ConnectionFailure implements Exception {
  const ConnectionFailure(this.code);
  final String code;
}

Uri _endpoint(String address) {
  final uri = Uri.parse(address);
  if (uri.scheme != 'wss' ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment) {
    throw const FormatException('Invalid relay address');
  }
  return uri;
}

List<int> _decodeKey(String encoded) {
  if (!_keyEncoding.hasMatch(encoded)) {
    throw const FormatException('Invalid computer key');
  }
  return base64Url.decode(base64Url.normalize(encoded));
}

Future<String> publicKeyFingerprint(List<int> key) async {
  final digest = await Sha256().hash(key);
  return digest.bytes
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();
}

List<String> _cleanLanAddresses(Iterable<String>? raw) {
  if (raw == null) return const [];
  final out = <String>[];
  final seen = <String>{};
  for (final item in raw) {
    final trimmed = item.trim();
    if (trimmed.isEmpty || trimmed.length > 256) continue;
    final uri = Uri.tryParse(trimmed);
    if (uri == null ||
        uri.scheme != 'ws' ||
        uri.host.isEmpty ||
        !uri.hasPort ||
        uri.userInfo.isNotEmpty ||
        uri.hasFragment) {
      continue;
    }
    final normalized = uri.toString();
    if (seen.add(normalized)) {
      out.add(normalized);
      if (out.length >= 8) break;
    }
  }
  return List.unmodifiable(out);
}

class ComputerProfile {
  ComputerProfile({
    required String address,
    required this.token,
    required this.computerKey,
    required this.name,
    this.relayRevision,
    List<String> lanAddresses = const [],
  }) : address = _endpoint(address),
       lanAddresses = _cleanLanAddresses(lanAddresses) {
    _decodeKey(computerKey);
    if (token.trim().isEmpty ||
        token.length > 4096 ||
        name.trim().isEmpty ||
        name.length > 80) {
      throw const FormatException('Invalid computer profile');
    }
  }

  final Uri address;
  final String token;
  final String computerKey;
  final String name;
  final String? relayRevision;
  final List<String> lanAddresses;

  factory ComputerProfile.fromJson(Map<String, dynamic> json) =>
      ComputerProfile(
        address: json['address'] as String,
        token: json['token'] as String,
        computerKey: json['computerKey'] as String,
        name: json['computerName'] as String,
        relayRevision: json['relayRevision'] as String?,
        lanAddresses: json['lanAddresses'] is List
            ? (json['lanAddresses'] as List).whereType<String>().toList()
            : const [],
      );

  ComputerProfile withRelayRevision(String? revision) => ComputerProfile(
    address: address.toString(),
    token: token,
    computerKey: computerKey,
    name: name,
    relayRevision: revision,
    lanAddresses: lanAddresses,
  );

  ComputerProfile withLanAddresses(List<String> addresses) => ComputerProfile(
    address: address.toString(),
    token: token,
    computerKey: computerKey,
    name: name,
    relayRevision: relayRevision,
    lanAddresses: addresses,
  );

  Map<String, Object> toJson() => {
    'address': address.toString(),
    'token': token,
    'computerKey': computerKey,
    'computerName': name,
    'relayRevision': ?relayRevision,
    if (lanAddresses.isNotEmpty) 'lanAddresses': lanAddresses,
  };
}

class PairingInvite {
  PairingInvite._(this.computer, this.secret, this.expiresAt);

  final ComputerProfile computer;
  final String secret;
  final DateTime expiresAt;

  factory PairingInvite.parse(String text) {
    if (text.length > 8192) throw const FormatException('Oversized pairing QR');
    final json = jsonDecode(text) as Map<String, dynamic>;
    if (json['type'] != 'pigcode.pair' || json['version'] != 1) {
      throw const FormatException('Invalid pairing QR');
    }
    final secret = json['secret'] as String;
    _decodeKey(secret);
    final expiry = DateTime.fromMillisecondsSinceEpoch(
      json['expiresAt'] as int,
    );
    if (!expiry.isAfter(DateTime.now())) {
      throw const ConnectionFailure('expired');
    }
    return PairingInvite._(ComputerProfile.fromJson(json), secret, expiry);
  }
}

String relayAdmission(String text) {
  final message = jsonDecode(text) as Map<String, dynamic>;
  final status = message['status'];
  if (message['type'] != 'relay.result' ||
      message['version'] != relayProtocolVersion ||
      !const {
        'ok',
        'offline',
        'busy',
        'token-rejected',
        'incompatible',
      }.contains(status)) {
    throw const ConnectionFailure('incompatible');
  }
  return status as String;
}

// WebSocket.connect delegates the HTTP upgrade to openUrl. Keep the relay
// token on the configured WSS origin by rejecting automatic redirects there.
class _RelayUpgradeClient implements HttpClient {
  _RelayUpgradeClient(this._client);

  final HttpClient _client;

  @override
  Future<HttpClientRequest> openUrl(String method, Uri url) async {
    final request = await _client.openUrl(method, url);
    request.followRedirects = false;
    return request;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Future<WebSocket> _openSocket(
  Uri uri,
  HttpClient? client, {
  Duration timeout = const Duration(seconds: 8),
}) async {
  // 每次建连使用独立 HttpClient，避免 iOS 在 Wi-Fi / 蜂窝切换后复用旧接口的陈旧池或半开连接。
  final owned = client == null ? HttpClient() : null;
  owned?.connectionTimeout = timeout;
  try {
    final opening = WebSocket.connect(
      uri.toString(),
      customClient: _RelayUpgradeClient(client ?? owned!),
    );
    final socket = await opening.timeout(
      timeout,
      onTimeout: () {
        owned?.close(force: true);
        unawaited(
          opening.then<void>(
            (lateSocket) => lateSocket.close(),
            onError: (Object _) {},
          ),
        );
        throw const ConnectionFailure('unreachable');
      },
    );
    owned?.close();
    socket.pingInterval = const Duration(seconds: 15);
    return socket;
  } catch (_) {
    owned?.close(force: true);
    throw const ConnectionFailure('unreachable');
  }
}

Future<WebSocket> _openRelaySocket(
  ComputerProfile computer,
  HttpClient? client,
) => _openSocket(computer.address, client);

enum RelayComputerState { online, offline, sleeping, exited, restarting }

class RelayComputerStatus {
  const RelayComputerStatus(this.state, this.lastOnlineAt);

  final RelayComputerState state;
  final DateTime? lastOnlineAt;

  factory RelayComputerStatus.fromJson(Map<String, dynamic> json) {
    if (json['type'] != 'relay.status') {
      throw ConnectionFailure(switch (json['status']) {
        'token-rejected' => 'token-rejected',
        'busy' => 'busy',
        _ => 'incompatible',
      });
    }
    final state = RelayComputerState.values.byName(json['state'] as String);
    final millis = json['lastOnlineAt'] as int?;
    return RelayComputerStatus(
      state,
      millis == null
          ? null
          : DateTime.fromMillisecondsSinceEpoch(millis, isUtc: true),
    );
  }
}

/// Status observations contain relay metadata. A session still authenticates the Host with Noise.
class RelayStatusWatch {
  RelayStatusWatch._(this._inbox, this.initial);

  final _RelayInbox _inbox;
  final RelayComputerStatus initial;
  bool _closed = false;

  static Future<RelayStatusWatch> open(
    ComputerProfile computer, {
    HttpClient? client,
  }) async {
    final socket = await _openRelaySocket(computer, client);
    final inbox = _RelayInbox(socket);
    try {
      socket.add(
        jsonEncode({
          'type': 'relay.watch',
          'version': relayProtocolVersion,
          'computerId': await publicKeyFingerprint(
            _decodeKey(computer.computerKey),
          ),
          'token': computer.token,
        }),
      );
      final first = await inbox.next(const Duration(seconds: 8));
      return RelayStatusWatch._(inbox, _decode(first));
    } catch (_) {
      await inbox.close();
      rethrow;
    }
  }

  static RelayComputerStatus _decode(Object frame) =>
      RelayComputerStatus.fromJson(
        jsonDecode(frame as String) as Map<String, dynamic>,
      );

  Stream<RelayComputerStatus> get updates async* {
    try {
      while (!_closed) {
        final message = await _inbox.next(null);
        yield _decode(message);
      }
    } on ConnectionFailure catch (failure) {
      if (!_closed || failure.code != 'closed') rethrow;
    }
  }

  Future<void> close() {
    _closed = true;
    return _inbox.close();
  }
}

// Keep the socket listener active while the app has no pending RPC. Pausing it
// would also pause WebSocket ping, pong and close handling.
class _RelayInbox {
  _RelayInbox(this._socket) {
    _subscription = _socket.listen(
      _received,
      onError: (Object _) => unawaited(close()),
      onDone: _finish,
    );
  }

  final WebSocket _socket;
  final Queue<Object> _buffer = Queue();
  final Completer<void> _finished = Completer();
  late final StreamSubscription<dynamic> _subscription;
  Completer<Object>? _waiting;

  Future<void> get done => _finished.future;

  void _received(Object? frame) {
    if (_finished.isCompleted) return;
    final valid = switch (frame) {
      List<int>() => frame.isNotEmpty && frame.length <= 65535,
      String() => frame.length <= 8192,
      _ => false,
    };
    if (!valid || _buffer.length >= 16) {
      unawaited(close());
      return;
    }
    final message = frame!;
    final reader = _waiting;
    if (reader == null) {
      _buffer.addLast(message);
    } else {
      _waiting = null;
      reader.complete(message);
    }
  }

  Future<Object> next(Duration? timeout) async {
    if (_buffer.isNotEmpty) return _buffer.removeFirst();
    if (_finished.isCompleted || _waiting != null) {
      throw const ConnectionFailure('closed');
    }
    final reader = Completer<Object>();
    _waiting = reader;
    try {
      return await (timeout == null
          ? reader.future
          : reader.future.timeout(timeout));
    } finally {
      if (identical(_waiting, reader)) _waiting = null;
    }
  }

  void _finish() {
    if (_finished.isCompleted) return;
    _finished.complete();
    final reader = _waiting;
    _waiting = null;
    reader?.completeError(const ConnectionFailure('closed'));
  }

  Future<void> close() async {
    _finish();
    _buffer.clear();
    // Stop the heartbeat before cancelling the reader that handles the close frame.
    _socket.pingInterval = null;
    unawaited(_socket.close().then<void>((_) {}, onError: (Object _) {}));
    await _subscription.cancel();
  }
}

class SecureLink {
  SecureLink._(
    this._socket,
    this._inbox,
    this._noise, {
    required this.isDirect,
  });

  final WebSocket _socket;
  final _RelayInbox _inbox;
  final NoiseSession _noise;
  final bool isDirect;
  bool _closed = false;
  Future<void> _writes = Future.value();

  String get verificationCode => _noise.verificationCode;
  Future<void> get done => _inbox.done;

  static Future<SecureLink> _completeHandshake(
    WebSocket socket,
    _RelayInbox inbox,
    NoiseIdentity identity,
    List<int> hostKey,
    Map<String, Object> handshake, {
    required bool isDirect,
    Duration timeout = const Duration(seconds: 8),
  }) async {
    final initiation = await NoiseInitiation.start(
      identity,
      hostKey,
      utf8.encode(jsonEncode(handshake)),
    );
    socket.add(initiation.message);
    final response = await inbox.next(timeout);
    final result = await initiation.finish(response as List<int>);
    if (handshake['revocationNotice'] == true && result.payload.isNotEmpty) {
      final notice = _map(utf8.decode(result.payload));
      if (notice.length == 1 && notice['type'] == 'device.revoked') {
        throw const ConnectionFailure('device-revoked');
      }
    }
    return SecureLink._(socket, inbox, result.session, isDirect: isDirect);
  }

  static Future<SecureLink> _dialDirectUrl(
    Uri uri,
    List<int> hostKey,
    NoiseIdentity identity,
    Map<String, Object> handshake,
    Duration timeout,
  ) async {
    final socket = await _openSocket(uri, null, timeout: timeout);
    final inbox = _RelayInbox(socket);
    try {
      return await _completeHandshake(
        socket,
        inbox,
        identity,
        hostKey,
        handshake,
        isDirect: true,
        timeout: timeout,
      );
    } on ConnectionFailure {
      await inbox.close();
      rethrow;
    } on TimeoutException {
      await inbox.close();
      throw const ConnectionFailure('unreachable');
    } on IOException {
      await inbox.close();
      throw const ConnectionFailure('unreachable');
    } catch (_) {
      await inbox.close();
      throw const ConnectionFailure('authentication-failed');
    }
  }

  /// 并发竞速尝试局域网内全部直连地址，同样走 Noise IK 双向认证与全链路加密。
  static Future<SecureLink> connectDirect(
    List<String> addresses, {
    required String computerKey,
    required NoiseIdentity identity,
    required Map<String, Object> handshake,
    Duration timeout = const Duration(milliseconds: 500),
  }) async {
    final clean = _cleanLanAddresses(addresses);
    if (clean.isEmpty) throw const ConnectionFailure('unreachable');
    final hostKey = _decodeKey(computerKey);
    final winner = Completer<SecureLink>();
    var remaining = clean.length;
    Object? lastError;

    for (final raw in clean) {
      unawaited(
        _dialDirectUrl(
          Uri.parse(raw),
          hostKey,
          identity,
          handshake,
          timeout,
        ).then(
          (link) {
            if (!winner.isCompleted) {
              winner.complete(link);
            } else {
              unawaited(link.close());
            }
          },
          onError: (Object error, StackTrace stack) {
            lastError = error;
            remaining -= 1;
            if (error is ConnectionFailure &&
                error.code == 'device-revoked' &&
                !winner.isCompleted) {
              winner.completeError(error, stack);
              return;
            }
            if (remaining == 0 && !winner.isCompleted) {
              winner.completeError(
                lastError ?? const ConnectionFailure('unreachable'),
              );
            }
          },
        ),
      );
    }
    return winner.future;
  }

  static Future<SecureLink> _connectRelay(
    ComputerProfile computer,
    NoiseIdentity identity,
    Map<String, Object> handshake, {
    HttpClient? client,
  }) async {
    final socket = await _openRelaySocket(computer, client);
    final inbox = _RelayInbox(socket);
    try {
      final hostKey = _decodeKey(computer.computerKey);
      final computerId = await publicKeyFingerprint(hostKey);
      socket.add(
        jsonEncode({
          'type': 'relay.phone',
          'version': relayProtocolVersion,
          'computerId': computerId,
          'token': computer.token,
        }),
      );
      final status = relayAdmission(
        await inbox.next(const Duration(seconds: 8)) as String,
      );
      if (status != 'ok') {
        throw ConnectionFailure(switch (status) {
          'offline' => 'offline',
          'token-rejected' => 'token-rejected',
          'busy' => 'busy',
          _ => 'incompatible',
        });
      }
      return await _completeHandshake(
        socket,
        inbox,
        identity,
        hostKey,
        handshake,
        isDirect: false,
      );
    } on ConnectionFailure {
      await inbox.close();
      rethrow;
    } on TimeoutException {
      await inbox.close();
      throw const ConnectionFailure('unreachable');
    } on IOException {
      await inbox.close();
      throw const ConnectionFailure('unreachable');
    } catch (_) {
      await inbox.close();
      throw const ConnectionFailure('authentication-failed');
    }
  }

  static Future<SecureLink> connect(
    ComputerProfile computer,
    NoiseIdentity identity,
    Map<String, Object> handshake, {
    HttpClient? client,
    Duration lanHeadStart = const Duration(milliseconds: 220),
    Duration lanTimeout = const Duration(milliseconds: 500),
  }) async {
    if (client != null ||
        computer.lanAddresses.isEmpty ||
        handshake['type'] != 'device.connect') {
      return _connectRelay(computer, identity, handshake, client: client);
    }

    // 同局域网优先抢跑 220ms：成功即直连且不建中继会话；外网或失败时自动无缝走回中继。
    final winner = Completer<SecureLink>();
    var relayStarted = false;
    var activeBranches = 1;
    Object? relayError;
    Timer? stagger;

    void finishErrorIfDone(Object error, StackTrace stack) {
      if (winner.isCompleted) return;
      if (error is ConnectionFailure && error.code == 'device-revoked') {
        stagger?.cancel();
        winner.completeError(error, stack);
        return;
      }
      if (activeBranches == 0) {
        winner.completeError(relayError ?? error, stack);
      }
    }

    void startRelay() {
      if (relayStarted || winner.isCompleted) return;
      relayStarted = true;
      activeBranches += 1;
      unawaited(
        _connectRelay(computer, identity, handshake).then(
          (link) {
            if (!winner.isCompleted) {
              winner.complete(link);
            } else {
              unawaited(link.close());
            }
          },
          onError: (Object error, StackTrace stack) {
            activeBranches -= 1;
            relayError = error;
            finishErrorIfDone(error, stack);
          },
        ),
      );
    }

    stagger = Timer(lanHeadStart, startRelay);
    unawaited(
      connectDirect(
        computer.lanAddresses,
        computerKey: computer.computerKey,
        identity: identity,
        handshake: handshake,
        timeout: lanTimeout,
      ).then(
        (link) {
          stagger?.cancel();
          if (!winner.isCompleted) {
            winner.complete(link);
          } else {
            unawaited(link.close());
          }
        },
        onError: (Object error, StackTrace stack) {
          stagger?.cancel();
          activeBranches -= 1;
          if (!(error is ConnectionFailure && error.code == 'device-revoked')) {
            startRelay();
          }
          finishErrorIfDone(error, stack);
        },
      ),
    );

    return winner.future;
  }

  Future<void> send(Map<String, Object?> value) {
    final write = _writes.then((_) async {
      if (_closed) throw const ConnectionFailure('closed');
      final ciphertext = await _noise.encrypt(utf8.encode(jsonEncode(value)));
      if (_closed) throw const ConnectionFailure('closed');
      _socket.add(ciphertext);
    });
    _writes = write.then<void>((_) {}, onError: (Object _) => close());
    return write;
  }

  Future<Map<String, dynamic>> receive({
    Duration? timeout = const Duration(seconds: 8),
  }) async {
    try {
      final value = _map(utf8.decode(await _receiveMessage(timeout)));
      if (value.length == 1 && value['type'] == 'device.revoked') {
        throw const ConnectionFailure('device-revoked');
      }
      return value;
    } on ConnectionFailure {
      await close();
      rethrow;
    } catch (_) {
      await close();
      throw const ConnectionFailure('closed');
    }
  }

  Future<Uint8List> _receiveMessage(Duration? timeout) async {
    final clock = Stopwatch()..start();
    Future<Uint8List> next() async {
      final wait = timeout == null ? null : timeout - clock.elapsed;
      if (wait != null && wait <= Duration.zero) {
        throw const ConnectionFailure('closed');
      }
      return _noise.decrypt(await _inbox.next(wait) as List<int>);
    }

    var frame = await next();
    if (frame.isNotEmpty && frame[0] != 0) return frame;

    // Length and offset are inside the Noise ciphertext and covered by its tag.
    const headerLength = 9;
    const maxMessageBytes = 256 * 1024 + 1024;
    final parts = BytesBuilder(copy: false);
    var expectedLength = 0;
    while (true) {
      if (frame.length <= headerLength || frame[0] != 0) {
        throw const FormatException('Invalid mobile message fragment');
      }
      final header = ByteData.sublistView(frame);
      final length = header.getUint32(1);
      final offset = header.getUint32(5);
      if (length > maxMessageBytes ||
          (expectedLength != 0 && expectedLength != length) ||
          offset != parts.length ||
          offset + frame.length - headerLength > length) {
        throw const FormatException('Invalid mobile message length or offset');
      }
      expectedLength = length;
      parts.add(Uint8List.sublistView(frame, headerLength));
      if (parts.length == expectedLength) return parts.takeBytes();
      frame = await next();
    }
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await _inbox.close();
  }

  static Map<String, dynamic> _map(String json) =>
      jsonDecode(json) as Map<String, dynamic>;
}
