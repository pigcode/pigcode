import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

Future<void> verifyUpgradeDoesNotRedirect(
  HttpClient client,
  PairingInvite invite,
  NoiseIdentity identity,
) async {
  final certificate = Platform.environment['PIGCODE_RELAY_TEST_CERT'];
  final key = Platform.environment['PIGCODE_RELAY_TEST_KEY'];
  if (certificate == null || key == null) return;
  final tls = SecurityContext()
    ..useCertificateChain(certificate)
    ..usePrivateKey(key);
  final target = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  var followed = false;
  target.listen((request) {
    followed = true;
    request.response.statusCode = HttpStatus.badRequest;
    unawaited(request.response.close());
  });
  try {
    final relay = await HttpServer.bindSecure(
      InternetAddress.loopbackIPv4,
      0,
      tls,
    );
    try {
      relay.listen((request) {
        unawaited(
          request.response.redirect(
            Uri(
              scheme: 'http',
              host: '127.0.0.1',
              port: target.port,
              path: '/ws/v1/connect',
            ),
            status: HttpStatus.temporaryRedirect,
          ),
        );
      });
      final profile = ComputerProfile(
        address: Uri(
          scheme: 'wss',
          host: '127.0.0.1',
          port: relay.port,
          path: '/ws/v1/connect',
        ).toString(),
        token: invite.computer.token,
        computerKey: invite.computer.computerKey,
        name: invite.computer.name,
      );
      try {
        final connection = await SecureLink.connect(profile, identity, {
          'type': 'device.connect',
        }, client: client);
        await connection.close();
        throw StateError('redirect returned a connection');
      } on ConnectionFailure catch (failure) {
        if (followed || failure.code != 'unreachable') {
          throw StateError('relay upgrade followed a redirect');
        }
      }
    } finally {
      await relay.close(force: true);
    }
  } finally {
    await target.close(force: true);
  }
}

Future<void> main() async {
  final certificate = Platform.environment['PIGCODE_RELAY_TEST_CA'];
  final context = SecurityContext(withTrustedRoots: true);
  if (certificate != null) context.setTrustedCertificates(certificate);
  final client = HttpClient(context: context);
  final invite = PairingInvite.parse(
    Platform.environment['PIGCODE_TEST_PAIRING_QR']!,
  );
  final identity = await NoiseIdentity.create();

  try {
    await verifyUpgradeDoesNotRedirect(client, invite, identity);
    final pending = await SecureLink.connect(invite.computer, identity, {
      'type': 'device.pair',
      'secret': invite.secret,
      'name': '验收手机',
      'platform': 'ios',
    }, client: client);
    await pending.send({'type': 'device.confirm'});
    if ((await pending.receive())['type'] != 'device.check') {
      throw StateError('missing verification prompt');
    }
    await pending.send({
      'jsonrpc': '2.0',
      'id': 'premature',
      'method': 'mobile.status',
      'params': {},
    });
    var blocked = false;
    try {
      await pending.receive();
    } on ConnectionFailure {
      blocked = true;
    }
    if (!blocked) throw StateError('RPC opened before approval');
    stdout.writeln(jsonEncode({'stage': 'blocked'}));

    final paired = await MobileConnection.pair(
      invite: invite,
      identity: identity,
      deviceName: '验收手机',
      platform: 'ios',
      showVerificationCode: (code) =>
          stdout.writeln(jsonEncode({'stage': 'code', 'code': code})),
      client: client,
    );
    if (paired.computerName != invite.computer.name) {
      throw StateError('connected to a different computer');
    }
    await paired.close();

    final restoredIdentity = await NoiseIdentity.create(identity.seed);
    final restoredProfile = ComputerProfile.fromJson(invite.computer.toJson());
    final resumed = await MobileConnection.resume(
      restoredProfile,
      restoredIdentity,
      client: client,
    );
    await resumed.close();

    final idleSeconds =
        int.tryParse(
          Platform.environment['PIGCODE_RELAY_TEST_IDLE_SECONDS'] ?? '',
        ) ??
        0;
    if (idleSeconds > 0) {
      final idle = await SecureLink.connect(restoredProfile, restoredIdentity, {
        'type': 'device.connect',
      }, client: client);
      await idle.send({
        'type': 'mobile.hello',
        'minVersion': 1,
        'maxVersion': 1,
        'features': ['connection.status'],
      });
      if ((await idle.receive())['type'] != 'mobile.welcome') {
        throw StateError('could not open idle verification connection');
      }
      await Future<void>.delayed(Duration(seconds: idleSeconds));
      await idle.send({
        'jsonrpc': '2.0',
        'id': 'idle',
        'method': 'mobile.status',
        'params': {},
      });
      final status = await idle.receive();
      if (status['id'] != 'idle' || status['result'] is! Map) {
        throw StateError('idle connection lost its authenticated status');
      }
      await idle.close();
    }

    final link = await SecureLink.connect(restoredProfile, restoredIdentity, {
      'type': 'device.connect',
    }, client: client);
    await link.send({
      'type': 'mobile.hello',
      'minVersion': 2,
      'maxVersion': 2,
      'features': <String>[],
    });
    if ((await link.receive())['type'] != 'mobile.incompatible') {
      throw StateError('incompatible client opened RPC');
    }
    await link.close();

    var reused = false;
    try {
      final stale = await SecureLink.connect(
        invite.computer,
        await NoiseIdentity.create(),
        {
          'type': 'device.pair',
          'secret': invite.secret,
          'name': '另一部手机',
          'platform': 'android',
        },
        client: client,
      );
      reused = true;
      await stale.close();
    } on ConnectionFailure {
      // The relay is reachable, but the consumed secret cannot open another session.
    }
    if (reused) throw StateError('one-time QR could be reused');
    stdout.writeln(jsonEncode({'stage': 'verified'}));
  } finally {
    client.close(force: true);
  }
}
