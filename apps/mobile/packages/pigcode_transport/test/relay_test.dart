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

  test('closing a per-connect HttpClient keeps an upgraded WebSocket alive', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(() => server.close(force: true));
    server.listen((request) async {
      final ws = await WebSocketTransformer.upgrade(request);
      ws.listen((data) => ws.add(data), onDone: () => ws.close());
    });

    final client = HttpClient()..connectionTimeout = const Duration(seconds: 5);
    final socket = await WebSocket.connect(
      'ws://127.0.0.1:${server.port}/ws',
      customClient: client,
    );
    client.close();
    addTearDown(() => socket.close());

    socket.add('hello-after-close');
    expect(await socket.first, 'hello-after-close');
  });
}
