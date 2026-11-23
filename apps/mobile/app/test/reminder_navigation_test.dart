import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/mobile_reminders.dart';
import 'package:pigcode_mobile/workspace.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

const first = MobileThreadSummary(
  id: 'recent',
  projectId: 'project',
  title: '最近打开的会话',
  updatedAt: '2026-11-23T08:00:00.000Z',
  archived: false,
  pinned: false,
  status: MobileThreadStatus.idle,
  unread: false,
);
const wanted = MobileThreadSummary(
  id: 'wanted',
  projectId: 'project',
  title: '通知目标会话',
  updatedAt: '2026-11-23T07:00:00.000Z',
  archived: false,
  pinned: false,
  status: MobileThreadStatus.waitingApproval,
  unread: false,
);
const target = MobileReminder(
  version: 1,
  eventId: 'request:req_one',
  threadId: 'wanted',
  kind: ReminderKind.approval,
  computerId:
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
);

Widget workspace({
  required bool online,
  required List<MobileThreadSummary> threads,
  MobileReminder? reminder,
  String? error,
  VoidCallback? onRetry,
  ValueChanged<String?>? onVisibleThread,
  ValueChanged<ValueChanged<bool>>? captureSyncCallback,
}) => MaterialApp(
  home: WorkspaceView(
    snapshot: SidebarSnapshot(
      projects: const [MobileProjectSummary(id: 'project', name: '测试项目')],
      threads: threads,
      syncedAt: DateTime.utc(2026, 11, 23),
    ),
    online: online,
    computerName: '目标电脑',
    openReminder: reminder,
    onComputers: () {},
    error: error,
    onRetry: onRetry,
    onVisibleThread: onVisibleThread,
    timeline: (thread, online, onSynced, _) {
      captureSyncCallback?.call(onSynced);
      return Text('会话内容 ${thread.id} ${online ? "已同步" : "缓存"}');
    },
  ),
);

void main() {
  testWidgets(
    'opens the notified conversation from cache and reconciles with Host',
    (tester) async {
      await tester.pumpWidget(
        workspace(online: false, threads: [first, wanted], reminder: target),
      );
      expect(find.text('会话内容 wanted 缓存'), findsOneWidget);
      await tester.pumpWidget(
        workspace(online: true, threads: [first, wanted], reminder: target),
      );
      expect(find.text('会话内容 wanted 已同步'), findsOneWidget);
    },
  );

  testWidgets(
    'waits for Host when the notified conversation is absent from cache',
    (tester) async {
      await tester.pumpWidget(
        workspace(online: false, threads: [first], reminder: target),
      );
      expect(find.text('连接电脑后打开通知里的会话。'), findsOneWidget);
      expect(find.text('会话内容 recent 缓存'), findsNothing);
      await tester.pumpWidget(
        workspace(online: true, threads: [first], reminder: target),
      );
      expect(find.text('通知对应的会话已不可用。'), findsOneWidget);
      expect(find.text('会话内容 recent 已同步'), findsNothing);
    },
  );

  testWidgets('retries a failed sidebar read while preserving the target', (
    tester,
  ) async {
    var retries = 0;
    await tester.pumpWidget(
      workspace(
        online: false,
        threads: [first],
        reminder: target,
        error: '暂时无法读取电脑上的会话。',
        onRetry: () => retries++,
      ),
    );
    await tester.tap(find.text('重试'));
    expect(retries, 1);
    await tester.pumpWidget(
      workspace(online: true, threads: [first, wanted], reminder: target),
    );
    expect(find.text('会话内容 wanted 已同步'), findsOneWidget);
  });

  testWidgets('reports the target as visible after its timeline syncs', (
    tester,
  ) async {
    final seen = <String?>[];
    late ValueChanged<bool> sync;
    await tester.pumpWidget(
      workspace(
        online: true,
        threads: [first, wanted],
        reminder: target,
        onVisibleThread: seen.add,
        captureSyncCallback: (callback) => sync = callback,
      ),
    );
    expect(seen, isEmpty);
    sync(true);
    await tester.pump();
    expect(seen, ['wanted']);
    sync(false);
    await tester.pump();
    expect(seen, ['wanted', null]);
  });

  test(
    'the computer reference selects the matching paired public key',
    () async {
      ComputerProfile pc(int seed) => ComputerProfile(
        address: 'wss://localhost/ws/v1/connect',
        token: 'fixture',
        computerKey: base64Url
            .encode(List<int>.filled(32, seed))
            .replaceAll('=', ''),
        name: '电脑 $seed',
      );
      final known = pc(2);
      final tap = MobileReminder.fromJson({
        ...target.toJson(),
        'computerId': await reminderComputerId(known),
      });
      expect(await findReminderComputer(tap, [pc(1), known]), same(known));
      expect(await findReminderComputer(tap, [pc(1)]), isNull);
    },
  );
}
