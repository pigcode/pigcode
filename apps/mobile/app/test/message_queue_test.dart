import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/run_composer.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

class _QueueHost implements HostRequests {
  bool failWithdraw = true;
  final actions = <Map<String, Object?>>[];
  final receiptLookups = <String>[];
  final messages = <QueuedMessage>[
    const QueuedMessage(id: 'first', text: '原本等待发送的消息', selected: false),
  ];

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    switch (method) {
      case QueueMethods.get:
        return QueueSnapshot(
          threadId: 'thread',
          paused: false,
          activeRunId: 'run',
          messages: messages,
        ).toJson();
      case QueueMethods.withdraw:
        actions.add(params);
        if (failWithdraw) throw const ConnectionFailure('closed');
        final item = messages.removeAt(0);
        return QueueReceipt(
          threadId: 'thread',
          commandId: params['commandId'] as String,
          method: QueueMethod.queueWithdraw,
          effect: QueueEffect.withdrawn,
          messageId: item.id,
          text: item.text,
        ).toJson();
      case MobileCommandMethods.receipt:
        receiptLookups.add(params['commandId'] as String);
        return <String, dynamic>{};
      case MobileCommandMethods.start:
        final pending = QueuedMessage(
          id: 'second',
          text: params['text'] as String,
          selected: false,
        );
        messages.add(pending);
        return MobileRunReceipt(
          method: MobileRunMethod.runStart,
          commandId: params['commandId'] as String,
          threadId: 'thread',
          queuedMessageId: pending.id,
          runId: 'future-run',
        ).toJson();
      default:
        throw StateError('Unexpected method: $method');
    }
  }
}

class _Connection implements MobileConnection {
  _Connection(_QueueHost host)
    : queue = MobileQueueCommands(host),
      runCommands = MobileRunCommands(host);

  @override
  final MobileQueueCommands queue;
  @override
  final MobileRunCommands runCommands;
  @override
  bool get supportsQueueCommands => true;
  @override
  final computer = ComputerProfile(
    address: 'wss://localhost/ws/v1/connect',
    token: 'fixture',
    computerKey: base64Url.encode(List<int>.filled(32, 3)).replaceAll('=', ''),
    name: '测试电脑',
  );
  @override
  String get deviceId => 'fixture-phone';
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _page(_Connection phone, {int revision = 0}) => ProviderScope(
  child: MaterialApp(
    home: Scaffold(
      body: RunComposer(
        connection: phone,
        threadId: 'thread',
        online: true,
        stoppableRunId: 'run',
        queueRevision: revision,
      ),
    ),
  ),
);

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets(
    'withdrawal restores the original text once on the initiating composer',
    (tester) async {
      final host = _QueueHost();
      final phone = _Connection(host);
      await tester.pumpWidget(_page(phone));
      await tester.pumpAndSettle();
      expect(find.text('原本等待发送的消息'), findsOneWidget);
      final input = find.byKey(const ValueKey('run-composer-input'));
      await tester.enterText(input, '另外在写的草稿');
      await tester.pumpAndSettle();
      expect(find.byTooltip('发送消息'), findsOneWidget);
      expect(find.byTooltip('停止本轮运行'), findsOneWidget);

      await tester.tap(find.text('撤回'));
      await tester.pumpAndSettle();
      expect(find.text('待发操作结果待确认'), findsOneWidget);
      final original = host.actions.single;
      host.failWithdraw = false;
      await tester.tap(find.text('用原编号重试'));
      await tester.pumpAndSettle();
      expect(host.receiptLookups, [original['commandId']]);
      expect(host.actions, [original, original]);
      final draft = tester.widget<TextField>(input).controller!.text;
      expect(draft, '另外在写的草稿\n原本等待发送的消息');
      expect(find.text('待发操作结果待确认'), findsNothing);
    },
  );

  testWidgets('sends to the shared queue while a run remains active', (
    tester,
  ) async {
    final host = _QueueHost();
    final phone = _Connection(host);
    await tester.pumpWidget(_page(phone));
    await tester.pumpAndSettle();
    final input = find.byKey(const ValueKey('run-composer-input'));
    await tester.enterText(input, '运行中追加的消息');
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('发送消息'));
    await tester.pumpAndSettle();
    await tester.pumpWidget(_page(phone, revision: 2));
    await tester.pumpAndSettle();
    expect(tester.widget<TextField>(input).controller!.text, isEmpty);
    expect(find.text('运行中追加的消息'), findsOneWidget);
    expect(find.byTooltip('停止本轮运行'), findsOneWidget);
  });
}
