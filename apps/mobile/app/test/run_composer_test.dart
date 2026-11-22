import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/mobile_command_journal.dart';
import 'package:pigcode_mobile/run_command_journal.dart';
import 'package:pigcode_mobile/run_composer.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

const _threadId = 'selected-thread';
final _input = find.byKey(const ValueKey('run-composer-input'));
final _send = find.widgetWithIcon(IconButton, Icons.arrow_upward);
final _stop = find.widgetWithIcon(IconButton, Icons.stop_rounded);

class _CommandHost implements HostRequests {
  _CommandHost({
    this.dropReply = false,
    this.recovered,
    this.lookupGate,
    this.rejectStart = false,
  });

  final bool dropReply;
  final MobileRunReceipt? recovered;
  final Future<void>? lookupGate;
  final bool rejectStart;
  final calls = <({String method, Map<String, Object?> params})>[];

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: params));
    if (method == MobileCommandMethods.receipt) {
      await lookupGate;
      return <String, dynamic>{
        if (recovered != null) 'receipt': recovered!.toJson(),
      };
    }
    if (dropReply) throw const ConnectionFailure('closed');
    if (rejectStart && method == MobileCommandMethods.start) {
      throw const MobileRpcFailure(
        MobileRpcProblem(code: 'THREAD_BUSY', message: '会话已有运行中的一轮。'),
      );
    }
    return <String, dynamic>{
      'method': method,
      'commandId': params['commandId'],
      'threadId': params['threadId'],
      'runId': params['runId'] ?? 'new-run',
    };
  }
}

class _Connection implements MobileConnection {
  _Connection(_CommandHost host, {int computerNumber = 0})
    : runCommands = MobileRunCommands(host),
      computer = ComputerProfile(
        address: 'wss://localhost/ws/v1/connect',
        token: 'fixture',
        computerKey: base64Url
            .encode(List<int>.filled(32, computerNumber))
            .replaceAll('=', ''),
        name: '电脑',
      );

  @override
  final MobileRunCommands runCommands;
  @override
  bool get supportsQueueCommands => false;
  @override
  final ComputerProfile computer;
  @override
  String get deviceId => 'fixture-phone';

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _page(
  MobileConnection connection, {
  bool online = true,
  String? stoppableRunId,
  TargetPlatform platform = TargetPlatform.iOS,
}) => ProviderScope(
  child: MaterialApp(
    theme: ThemeData(platform: platform),
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: RunComposer(
          connection: connection,
          threadId: _threadId,
          online: online,
          stoppableRunId: stoppableRunId,
        ),
      ),
    ),
  ),
);

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  const savedSend = PendingSend(
    MobileStartRunParams(
      commandId: '00000000-0000-4000-8000-000000000001',
      threadId: _threadId,
      text: '保存在本机的发信内容',
    ),
  );

  testWidgets('keeps drafts offline and retries only the saved text and ID', (
    tester,
  ) async {
    final before = _CommandHost(dropReply: true);
    final first = _Connection(before);
    final after = _CommandHost();
    final second = _Connection(after);
    const original = '  手机输入\n保留原文  ';

    await tester.pumpWidget(_page(first, online: false));
    await tester.pumpAndSettle();
    await tester.enterText(_input, original);
    await tester.pump();
    expect(tester.widget<IconButton>(_send).onPressed, isNull);
    expect(before.calls, isEmpty);
    expect(tester.getSize(_send).width, 44);

    await tester.pumpWidget(_page(first));
    await tester.tap(_send);
    await tester.pumpAndSettle();
    final initial = before.calls.single;
    expect(initial.method, MobileCommandMethods.start);
    expect(initial.params, containsPair('text', original));
    expect(initial.params, containsPair('threadId', _threadId));
    expect(find.text('发送结果待确认'), findsOneWidget);

    await tester.pumpWidget(_page(second));
    await tester.pumpAndSettle();
    final lookup = (
      method: MobileCommandMethods.receipt,
      params: {'commandId': initial.params['commandId']},
    );
    expect(after.calls.single.method, lookup.method);
    expect(after.calls.single.params, lookup.params);
    expect(tester.widget<IconButton>(_send).onPressed, isNull);

    await tester.enterText(_input, '继续修改草稿');
    await tester.tap(find.text('查回执'));
    await tester.pumpAndSettle();
    expect(after.calls.map((call) => call.method), [
      lookup.method,
      lookup.method,
    ]);
    await tester.tap(find.text('用原编号重试'));
    await tester.pumpAndSettle();
    expect(after.calls.map((call) => call.method), [
      lookup.method,
      lookup.method,
      lookup.method,
      initial.method,
    ]);
    expect(after.calls.last.params, initial.params);
    expect(find.text('发送结果待确认'), findsNothing);
    expect(tester.widget<TextField>(_input).controller!.text, '继续修改草稿');
  });

  testWidgets(
    'clears acknowledged input and stops the current run above the keyboard',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 780);
      tester.view.viewInsets = const FakeViewPadding(bottom: 300);
      addTearDown(tester.view.reset);
      final host = _CommandHost();
      final connection = _Connection(host);

      await tester.pumpWidget(
        _page(connection, platform: TargetPlatform.android),
      );
      await tester.pumpAndSettle();
      await tester.enterText(_input, '发送后清空');
      await tester.pump();
      await tester.tap(_send);
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(_input).controller!.text, isEmpty);

      await tester.pumpWidget(
        _page(
          connection,
          stoppableRunId: 'current-run',
          platform: TargetPlatform.android,
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.getSize(_stop).width, 48);
      expect(tester.getBottomLeft(_stop).dy, lessThanOrEqualTo(480));
      await tester.tap(_stop);
      await tester.pumpAndSettle();
      expect(host.calls.last.method, MobileCommandMethods.interrupt);
      expect(host.calls.last.params, containsPair('threadId', _threadId));
      expect(host.calls.last.params, containsPair('runId', 'current-run'));
    },
  );

  test(
    'removing one computer clears only that computer’s unresolved commands',
    () async {
      final host = _CommandHost();
      final first = _Connection(host);
      final second = _Connection(host, computerNumber: 1);
      final original = RunCommandJournal(first, _threadId);
      final other = RunCommandJournal(second, _threadId);
      await original.reserve(savedSend);
      await other.reserve(savedSend);
      await MobileCommandJournal.clearForComputer(first.computer.computerKey);
      expect(await original.read(savedSend.method), isNull);
      expect(
        (await other.read(savedSend.method))?.commandId,
        savedSend.commandId,
      );
    },
  );

  testWidgets(
    'shows the original run when reconnecting finds an accepted send',
    (tester) async {
      final host = _CommandHost(
        recovered: MobileRunReceipt(
          method: savedSend.method,
          commandId: savedSend.commandId,
          threadId: _threadId,
          runId: 'original-run',
        ),
      );
      final connection = _Connection(host);
      final journal = RunCommandJournal(connection, _threadId);
      await journal.reserve(savedSend);
      await tester.pumpWidget(_page(connection));
      await tester.pumpAndSettle();
      expect(host.calls.single.method, MobileCommandMethods.receipt);
      expect(find.text('已找回发送回执'), findsOneWidget);
      expect(find.text('original-run'), findsOneWidget);
      expect(await journal.read(savedSend.method), isNull);
    },
  );

  testWidgets('restores the original draft when an explicit retry is refused', (
    tester,
  ) async {
    final host = _CommandHost(rejectStart: true);
    final connection = _Connection(host);
    await RunCommandJournal(connection, _threadId).reserve(savedSend);
    await tester.pumpWidget(_page(connection));
    await tester.pumpAndSettle();
    await tester.tap(find.text('用原编号重试'));
    await tester.pumpAndSettle();
    expect(host.calls.last.params, savedSend.toJson());
    expect(find.text('会话已有运行中的一轮。'), findsOneWidget);
    expect(
      tester.widget<TextField>(_input).controller!.text,
      savedSend.params.text,
    );
  });

  testWidgets('keeps the pending command after leaving during receipt lookup', (
    tester,
  ) async {
    final gate = Completer<void>();
    final receipt = MobileRunReceipt(
      method: savedSend.method,
      commandId: savedSend.commandId,
      threadId: _threadId,
      runId: 'original-run',
    );
    final host = _CommandHost(recovered: receipt, lookupGate: gate.future);
    final connection = _Connection(host);
    final journal = RunCommandJournal(connection, _threadId);
    await journal.reserve(savedSend);
    await tester.pumpWidget(_page(connection));
    await tester.pumpAndSettle();
    expect(host.calls.single.method, MobileCommandMethods.receipt);
    await tester.pumpWidget(const SizedBox.shrink());
    gate.complete();
    await tester.pumpAndSettle();
    expect(
      (await journal.read(savedSend.method))?.commandId,
      savedSend.commandId,
    );

    await tester.pumpWidget(
      _page(_Connection(_CommandHost(recovered: receipt))),
    );
    await tester.pumpAndSettle();
    expect(find.text('已找回发送回执'), findsOneWidget);
    expect(await journal.read(savedSend.method), isNull);
  });
}
