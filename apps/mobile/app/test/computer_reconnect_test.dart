import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/computer_reconnect.dart';
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
}
