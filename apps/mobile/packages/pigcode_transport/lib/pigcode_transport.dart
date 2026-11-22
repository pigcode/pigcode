import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:io';

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

class ComputerProfile {
  ComputerProfile({
    required String address,
    required this.token,
    required this.computerKey,
    required this.name,
    this.relayRevision,
  }) : address = _endpoint(address) {
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

  factory ComputerProfile.fromJson(Map<String, dynamic> json) =>
      ComputerProfile(
        address: json['address'] as String,
        token: json['token'] as String,
        computerKey: json['computerKey'] as String,
        name: json['computerName'] as String,
        relayRevision: json['relayRevision'] as String?,
      );

  ComputerProfile withRelayRevision(String? revision) => ComputerProfile(
    address: address.toString(),
    token: token,
    computerKey: computerKey,
    name: name,
    relayRevision: revision,
  );

  Map<String, Object> toJson() => {
    'address': address.toString(),
    'token': token,
    'computerKey': computerKey,
    'computerName': name,
    'relayRevision': ?relayRevision,
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

final _relayHttpClient = HttpClient();

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
    unawaited(_socket.close().then<void>((_) {}, onError: (Object _) {}));
    await _subscription.cancel();
  }
}

class SecureLink {
  SecureLink._(this._socket, this._inbox, this._noise);

  final WebSocket _socket;
  final _RelayInbox _inbox;
  final NoiseSession _noise;
  bool _closed = false;
  Future<void> _writes = Future.value();

  String get verificationCode => _noise.verificationCode;
  Future<void> get done => _inbox.done;

  static Future<SecureLink> connect(
    ComputerProfile computer,
    NoiseIdentity identity,
    Map<String, Object> handshake, {
    HttpClient? client,
  }) async {
    late final WebSocket socket;
    try {
      final opening = WebSocket.connect(
        computer.address.toString(),
        customClient: _RelayUpgradeClient(client ?? _relayHttpClient),
      );
      socket = await opening.timeout(
        const Duration(seconds: 8),
        onTimeout: () {
          unawaited(
            opening.then<void>(
              (lateSocket) => lateSocket.close(),
              onError: (Object _) {},
            ),
          );
          throw const ConnectionFailure('unreachable');
        },
      );
    } catch (_) {
      throw const ConnectionFailure('unreachable');
    }
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
      final initiation = await NoiseInitiation.start(
        identity,
        hostKey,
        utf8.encode(jsonEncode(handshake)),
      );
      socket.add(initiation.message);
      final response = await inbox.next(const Duration(seconds: 8));
      final result = await initiation.finish(response as List<int>);
      return SecureLink._(socket, inbox, result.session);
    } on ConnectionFailure {
      await inbox.close();
      rethrow;
    } catch (_) {
      await inbox.close();
      throw const ConnectionFailure('authentication-failed');
    }
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
      final frame = await _inbox.next(timeout);
      final plain = await _noise.decrypt(frame as List<int>);
      return _map(utf8.decode(plain));
    } catch (_) {
      await close();
      throw const ConnectionFailure('closed');
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
