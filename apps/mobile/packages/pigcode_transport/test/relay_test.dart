import 'dart:convert';
import 'dart:io';

import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:test/test.dart';

void main() {
  test('reads the shared admission outcomes from the Go relay', () {
    final file = File(
      '../../../../packages/contracts/fixtures/relay-route-v1.json',
    );
    final fixture = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
    expect(relayAdmission(jsonEncode(fixture['admitted'])), 'ok');
    expect(relayAdmission(jsonEncode(fixture['offline'])), 'offline');
    final unseen = RelayComputerStatus.fromJson(
      fixture['neverOnline'] as Map<String, dynamic>,
    );
    expect(unseen.state, RelayComputerState.offline);
    expect(unseen.lastOnlineAt, isNull);
    final sleeping = RelayComputerStatus.fromJson(
      fixture['sleeping'] as Map<String, dynamic>,
    );
    expect(sleeping.state, RelayComputerState.sleeping);
    expect(sleeping.lastOnlineAt?.millisecondsSinceEpoch, 1795392000000);
  });

  test(
    'closing a per-connect HttpClient keeps an upgraded WebSocket alive',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      addTearDown(() => server.close(force: true));
      server.listen((request) async {
        final ws = await WebSocketTransformer.upgrade(request);
        ws.listen((data) => ws.add(data), onDone: () => ws.close());
      });

      final client = HttpClient()
        ..connectionTimeout = const Duration(seconds: 5);
      final socket = await WebSocket.connect(
        'ws://127.0.0.1:${server.port}/ws',
        customClient: client,
      );
      client.close();
      addTearDown(() => socket.close());

      socket.add('hello-after-close');
      expect(await socket.first, 'hello-after-close');
    },
  );

  test(
    'ComputerProfile persists sanitized lanAddresses and preserves them across withRelayRevision',
    () {
      const hostKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      final profile = ComputerProfile(
        address: 'wss://relay.example/ws/v1/connect',
        token: 'tok',
        computerKey: hostKey,
        name: 'My Mac',
        lanAddresses: const [
          'ws://192.168.1.10:39871/ws',
          'https://not-ws.example',
          'ws://10.0.0.5:39871/ws',
          'ws://192.168.1.10:39871/ws',
        ],
      );
      expect(profile.lanAddresses, [
        'ws://192.168.1.10:39871/ws',
        'ws://10.0.0.5:39871/ws',
      ]);

      final updated = profile.withRelayRevision('rev-1');
      expect(updated.lanAddresses, profile.lanAddresses);
      expect(updated.relayRevision, 'rev-1');

      final roundTrip = ComputerProfile.fromJson({
        ...updated.toJson(),
        'computerName': updated.name,
      });
      expect(roundTrip.lanAddresses, profile.lanAddresses);
    },
  );

  test(
    'SecureLink.connectDirect fails fast when LAN ports are closed',
    () async {
      final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
      final deadPort = server.port;
      await server.close();

      final identity = await NoiseIdentity.create();
      final host = await NoiseIdentity.create();
      final hostKeyB64 = base64Url.encode(host.publicKey).replaceAll('=', '');

      await expectLater(
        SecureLink.connectDirect(
          ['ws://127.0.0.1:$deadPort/ws'],
          computerKey: hostKeyB64,
          identity: identity,
          handshake: const {'type': 'device.connect', 'revocationNotice': true},
          timeout: const Duration(milliseconds: 300),
        ),
        throwsA(
          isA<ConnectionFailure>().having((e) => e.code, 'code', 'unreachable'),
        ),
      );
    },
  );
}
