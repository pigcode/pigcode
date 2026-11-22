import 'dart:io';

import 'package:pigcode_transport/pigcode_transport.dart';

const mobileProtocolVersion = 1;

class MobileConnection {
  MobileConnection._(this._link, this.computerName);

  final SecureLink _link;
  final String computerName;

  Future<void> get done => _link.done;
  Future<void> close() => _link.close();

  static Future<MobileConnection> pair({
    required PairingInvite invite,
    required NoiseIdentity identity,
    required String deviceName,
    required String platform,
    required void Function(String) showVerificationCode,
    HttpClient? client,
  }) => _connect(
    invite.computer,
    identity,
    client: client,
    handshake: {
      'type': 'device.pair',
      'secret': invite.secret,
      'name': deviceName,
      'platform': platform,
    },
    confirm: (link) async {
      await link.send({'type': 'device.confirm'});
      final prompt = await link.receive();
      if (prompt['type'] != 'device.check') {
        throw const ConnectionFailure('authentication-failed');
      }
      showVerificationCode(link.verificationCode);
      final remaining = invite.expiresAt.difference(DateTime.now());
      if (remaining.isNegative) throw const ConnectionFailure('expired');
      final approval = await link.receive(timeout: remaining);
      if (approval['type'] != 'device.approved') {
        throw const ConnectionFailure('authentication-failed');
      }
    },
  );

  static Future<MobileConnection> resume(
    ComputerProfile computer,
    NoiseIdentity identity, {
    HttpClient? client,
  }) => _connect(
    computer,
    identity,
    client: client,
    handshake: {'type': 'device.connect'},
  );

  static Future<MobileConnection> _connect(
    ComputerProfile computer,
    NoiseIdentity identity, {
    required Map<String, Object> handshake,
    required HttpClient? client,
    Future<void> Function(SecureLink)? confirm,
  }) async {
    final link = await SecureLink.connect(
      computer,
      identity,
      handshake,
      client: client,
    );
    try {
      if (confirm != null) await confirm(link);
      await link.send({
        'type': 'mobile.hello',
        'minVersion': mobileProtocolVersion,
        'maxVersion': mobileProtocolVersion,
        'features': ['connection.status'],
      });
      final welcome = await link.receive();
      if (welcome['type'] == 'mobile.incompatible') {
        final min = welcome['minVersion'];
        final max = welcome['maxVersion'];
        if (min is int && min > mobileProtocolVersion) {
          throw const ConnectionFailure('update-phone');
        }
        if (max is int && max < mobileProtocolVersion) {
          throw const ConnectionFailure('update-desktop');
        }
      }
      if (welcome['type'] != 'mobile.welcome' ||
          welcome['version'] != mobileProtocolVersion ||
          !(welcome['features'] as List).contains('connection.status')) {
        throw const ConnectionFailure('incompatible');
      }
      await link.send({
        'jsonrpc': '2.0',
        'id': 'status',
        'method': 'mobile.status',
        'params': {},
      });
      final response = await link.receive();
      if (response['id'] != 'status') {
        throw const ConnectionFailure('authentication-failed');
      }
      final status = response['result'] as Map<String, dynamic>;
      return MobileConnection._(link, status['computerName'] as String);
    } catch (_) {
      await link.close();
      rethrow;
    }
  }
}
