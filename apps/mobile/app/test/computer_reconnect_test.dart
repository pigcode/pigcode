import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/computer_reconnect.dart';
import 'package:pigcode_mobile/main.dart' show shouldReconnectForNetworkChange;
import 'package:pigcode_transport/pigcode_transport.dart';

class _Connection implements MobileConnection {
  final _closed = Completer<void>();
  bool get closed => _closed.isCompleted;

  @override
  bool revoked = false;

  @override
  Future<void> get done => _closed.future;

  @override
  Future<void> close() async {
    if (!closed) _closed.complete();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Watch implements RelayStatusWatch {
  _Watch(this.initial);

  @override
  final RelayComputerStatus initial;
  final changes = StreamController<RelayComputerStatus>.broadcast();

  @override
  Stream<RelayComputerStatus> get updates => changes.stream;

  @override
  Future<void> close() => changes.close();
}

void main() {
  testWidgets('a confirmed revocation ends the pairing without retrying', (
    tester,
  ) async {
    final connection = _Connection();
    var dials = 0;
    final session = ComputerReconnect(
      dial: () async {
        dials++;
        throw const ConnectionFailure('offline');
      },
      observe: () async => throw const ConnectionFailure('incompatible'),
      onChange: () {},
    );
    session.start(foreground: true, initial: connection);
    connection.revoked = true;
    await connection.close();
    await tester.pump();
    expect(session.error, 'device-revoked');
    session.retry();
    await tester.pump(const Duration(seconds: 10));
    expect(session.connection, isNull);
    expect(dials, 0);
    session.dispose();
  });

  testWidgets('network switch discards a late dial from the previous network', (
    tester,
  ) async {
    final oldDial = Completer<MobileConnection>();
    final newDial = Completer<MobileConnection>();
    final oldConnection = _Connection();
    final newConnection = _Connection();
    var dials = 0;
    final session = ComputerReconnect(
      dial: () => (++dials == 1 ? oldDial : newDial).future,
      observe: () async => throw const ConnectionFailure('incompatible'),
      onChange: () {},
    );
    session.start(foreground: true);
    session.retry();
    newDial.complete(newConnection);
    await tester.pump();
    oldDial.complete(oldConnection);
    await tester.pump();
    expect(oldConnection.closed, isTrue);
    expect(session.connection, same(newConnection));
    expect(dials, 2);
    session.dispose();
    await tester.pump();
    expect(newConnection.closed, isTrue);
  });

  testWidgets('retry drops the old status until the new watch answers', (
    tester,
  ) async {
    final lastSeen = DateTime.utc(2026, 11, 23);
    final previous = _Watch(
      RelayComputerStatus(RelayComputerState.offline, lastSeen),
    );
    final next = Completer<RelayStatusWatch>();
    var watches = 0;
    final session = ComputerReconnect(
      dial: () async => _Connection(),
      observe: () => ++watches == 1 ? Future.value(previous) : next.future,
      onChange: () {},
    );
    session.start(foreground: true);
    await tester.pump();
    expect(session.status?.state, RelayComputerState.offline);
    session.retry();
    await tester.pump();
    expect(session.status, isNull);
    next.complete(
      _Watch(RelayComputerStatus(RelayComputerState.online, lastSeen)),
    );
    await tester.pump();
    expect(session.status?.state, RelayComputerState.online);
    session.dispose();
    await tester.pump();
  });

  testWidgets('Host wake and app foreground each resume the saved connection', (
    tester,
  ) async {
    final lastSeen = DateTime.utc(2026, 11, 23);
    final sleeping = _Watch(
      RelayComputerStatus(RelayComputerState.sleeping, lastSeen),
    );
    final awake = _Watch(
      RelayComputerStatus(RelayComputerState.online, lastSeen),
    );
    final first = _Connection();
    final resumed = _Connection();
    var dials = 0;
    var watches = 0;
    final session = ComputerReconnect(
      dial: () async => switch (++dials) {
        1 => throw const ConnectionFailure('offline'),
        2 => first,
        _ => resumed,
      },
      observe: () async => ++watches == 1 ? sleeping : awake,
      onChange: () {},
    );
    session.start(foreground: true);
    await tester.pump();
    expect(session.status?.state, RelayComputerState.sleeping);
    expect(session.status?.lastOnlineAt, lastSeen);
    sleeping.changes.add(awake.initial);
    await tester.pump();
    expect(session.connection, same(first));
    session.setForeground(false);
    await tester.pump(const Duration(seconds: 10));
    expect(first.closed, isTrue);
    expect(dials, 2);
    session.setForeground(true);
    await tester.pump();
    expect(session.connection, same(resumed));
    expect(dials, 3);
    session.dispose();
    await tester.pump();
  });

  testWidgets(
    'online push arriving during a stale in-flight dial triggers immediate reconnect',
    (tester) async {
      final lastSeen = DateTime.utc(2026, 11, 25);
      final watch = _Watch(
        RelayComputerStatus(RelayComputerState.offline, lastSeen),
      );
      final staleDial = Completer<MobileConnection>();
      final recovered = _Connection();
      var dials = 0;
      final session = ComputerReconnect(
        dial: () {
          dials++;
          if (dials == 1) return staleDial.future;
          return Future.value(recovered);
        },
        observe: () async => watch,
        onChange: () {},
      );

      session.start(foreground: true);
      await tester.pump();
      expect(session.connecting, isTrue);
      expect(session.status?.state, RelayComputerState.offline);

      // 电脑在旧拨号尚未返回时上线，中继先推送 online。
      watch.changes.add(
        RelayComputerStatus(RelayComputerState.online, lastSeen),
      );
      await tester.pump();
      expect(session.status?.state, RelayComputerState.online);

      // 旧拨号返回过时的 offline，应该立刻触发第二次拨号而无需等待退避计时器。
      staleDial.completeError(const ConnectionFailure('offline'));
      await tester.pump();
      expect(dials, 2);
      expect(session.connection, same(recovered));
      expect(session.error, isNull);
      session.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'retry on active network switch closes the stale socket and reconnects immediately',
    (tester) async {
      final wifiConnection = _Connection();
      final cellularConnection = _Connection();
      var dials = 0;
      final session = ComputerReconnect(
        dial: () async => ++dials == 1 ? cellularConnection : _Connection(),
        observe: () async => throw const ConnectionFailure('incompatible'),
        onChange: () {},
      );
      session.start(foreground: true, initial: wifiConnection);
      expect(session.connection, same(wifiConnection));

      // 模拟 Wi-Fi -> 4G 切换：旧 socket 尚未报 closed，主动 retry 应立即断开旧连接并切新连接。
      session.retry();
      await tester.pump();
      expect(wifiConnection.closed, isTrue);
      expect(dials, 1);
      expect(session.connection, same(cellularConnection));
      session.dispose();
      await tester.pump();
      expect(cellularConnection.closed, isTrue);
    },
  );

  test('detects routable transport changes for Wi-Fi, cellular, and VPN', () {
    expect(
      shouldReconnectForNetworkChange(
        const {ConnectivityResult.wifi},
        const {ConnectivityResult.mobile},
      ),
      isTrue,
    );
    expect(
      shouldReconnectForNetworkChange(
        const {ConnectivityResult.mobile},
        const {ConnectivityResult.wifi},
      ),
      isTrue,
    );
    expect(
      shouldReconnectForNetworkChange(
        const {ConnectivityResult.wifi},
        const {ConnectivityResult.none},
      ),
      isTrue,
    );
    expect(
      shouldReconnectForNetworkChange(
        const {ConnectivityResult.none},
        const {ConnectivityResult.mobile},
      ),
      isTrue,
    );
    expect(
      shouldReconnectForNetworkChange(
        const {ConnectivityResult.wifi},
        const {ConnectivityResult.wifi, ConnectivityResult.vpn},
      ),
      isTrue,
    );
    expect(
      shouldReconnectForNetworkChange(
        const {ConnectivityResult.wifi},
        const {ConnectivityResult.wifi},
      ),
      isFalse,
    );
    expect(
      shouldReconnectForNetworkChange(
        const {ConnectivityResult.wifi},
        const {ConnectivityResult.wifi, ConnectivityResult.bluetooth},
      ),
      isFalse,
    );
    expect(
      shouldReconnectForNetworkChange(
        const {ConnectivityResult.none},
        const {ConnectivityResult.none},
      ),
      isFalse,
    );
  });
}
