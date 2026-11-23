import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/thread_read_receipt.dart';

void main() {
  testWidgets('confirms a visible synced result and respects a manual unread', (
    tester,
  ) async {
    final original = tester.binding.lifecycleState;
    addTearDown(() {
      if (original != null) {
        tester.binding.handleAppLifecycleStateChanged(original);
      }
    });
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    const target = MobileThreadReadTarget(runId: 'run', revision: 0);
    const unreadAgain = MobileThreadReadTarget(runId: 'run', revision: 1);
    final received = <MobileThreadReadTarget>[];

    Widget surface({
      bool visible = true,
      MobileThreadReadTarget? current = target,
      String? shownRun,
      MobileThreadReadTarget? manualUnread,
      int visit = 0,
    }) => ThreadReadReceipt(
      visible: visible,
      shownRunId: shownRun ?? current?.runId,
      target: current,
      manualUnread: manualUnread,
      unread: true,
      visit: visit,
      confirm: (receipt) async => received.add(receipt),
      child: const SizedBox(),
    );

    await tester.pumpWidget(surface(visible: false));
    await tester.pumpWidget(surface(current: null));
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pumpWidget(surface());
    expect(received, isEmpty);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(received, [target]);

    await tester.pumpWidget(
      surface(current: unreadAgain, manualUnread: unreadAgain),
    );
    expect(received, [target]);
    await tester.pumpWidget(
      surface(current: unreadAgain, manualUnread: unreadAgain, visit: 1),
    );
    expect(received, [target, unreadAgain]);
  });

  testWidgets(
    'binds the shown run before sidebar metadata arrives and retries on a new connection',
    (tester) async {
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      const manualUnread = MobileThreadReadTarget(runId: 'run', revision: 1);
      final firstLink = Object();
      final nextLink = Object();
      final firstAttempt = Completer<void>();
      var attempts = 0;

      Widget show({
        required Object connection,
        MobileThreadReadTarget? target,
        int visit = 0,
      }) => ThreadReadReceipt(
        visible: true,
        shownRunId: 'run',
        target: target,
        manualUnread: target,
        connection: connection,
        unread: true,
        visit: visit,
        confirm: (_) async {
          if (++attempts == 1) await firstAttempt.future;
        },
        child: const SizedBox(),
      );

      await tester.pumpWidget(show(connection: firstLink));
      await tester.pumpWidget(
        show(connection: firstLink, target: manualUnread),
      );
      expect(attempts, 0);
      await tester.pumpWidget(
        show(connection: firstLink, target: manualUnread, visit: 1),
      );
      expect(attempts, 1);
      await tester.pumpWidget(
        show(connection: nextLink, target: manualUnread, visit: 1),
      );
      expect(attempts, 2);
      firstAttempt.completeError(StateError('closed'));
      await tester.pump();
      await tester.pumpWidget(
        show(connection: nextLink, target: manualUnread, visit: 1),
      );
      expect(attempts, 2);
    },
  );
}
