import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/composer/composer_tokens.dart';
import 'package:pigcode_mobile/composer/mobile_composer_card.dart';
import 'package:pigcode_mobile/mobile_glass.dart';
import 'package:pigcode_mobile/timeline/optimistic_user_bubble.dart';
import 'package:pigcode_mobile/timeline_pane.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

const _threadId = 'optimistic-thread';
final _input = find.byKey(const ValueKey('run-composer-input'));

class _FakeHost implements HostRequests {
  _FakeHost({
    this.dropStart = false,
    this.rejectStart = false,
    this.startGate,
  });

  bool dropStart;
  bool rejectStart;
  Completer<void>? startGate;
  final calls = <({String method, Map<String, Object?> params})>[];
  final _notifications = StreamController<Map<String, dynamic>>.broadcast();
  final _events = <Map<String, dynamic>>[
    {
      'seq': 1,
      'runId': 'run-0',
      'kind': 'message.user',
      'createdAt': '2026-11-26T01:00:00.000Z',
      'text': '历史消息',
    },
    {
      'seq': 2,
      'runId': 'run-0',
      'kind': 'message.assistant',
      'createdAt': '2026-11-26T01:00:02.000Z',
      'text': '历史回复',
    },
    {
      'seq': 3,
      'runId': 'run-0',
      'kind': 'run.completed',
      'createdAt': '2026-11-26T01:00:03.000Z',
    },
  ];
  int _nextSeq = 4;

  void emitUserEvent({required String runId, required String text}) {
    final previousSeq = _nextSeq - 1;
    final event = {
      'seq': _nextSeq++,
      'runId': runId,
      'kind': 'message.user',
      'createdAt': '2026-11-26T02:00:00.000Z',
      'text': text,
    };
    _events.add(event);
    _notifications.add({
      'jsonrpc': '2.0',
      'method': MobileTimelineMethods.event,
      'params': {
        'threadId': _threadId,
        'previousSeq': previousSeq,
        'event': event,
      },
    });
  }

  @override
  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: params));
    switch (method) {
      case MobileTimelineMethods.subscribe:
        return {
          'page': {
            'events': _events,
            'through': _nextSeq - 1,
          },
        };
      case MobileTimelineMethods.unsubscribe:
        return <String, dynamic>{};
      case MobileCommandMethods.receipt:
        return <String, dynamic>{};
      case MobileCommandMethods.start:
        if (startGate case final gate?) await gate.future;
        if (dropStart) throw const ConnectionFailure('closed');
        if (rejectStart) {
          throw const MobileRpcFailure(
            MobileRpcProblem(code: 'THREAD_BUSY', message: '会话已有运行中的一轮。'),
          );
        }
        return {
          'method': method,
          'commandId': params['commandId'],
          'threadId': params['threadId'],
          'runId': 'run-new',
        };
      default:
        return <String, dynamic>{};
    }
  }

  Future<void> dispose() => _notifications.close();
}

class _FakeConnection implements MobileConnection {
  _FakeConnection(this._host)
    : runCommands = MobileRunCommands(_host),
      computer = ComputerProfile(
        address: 'wss://localhost/ws/v1/connect',
        token: 'fixture',
        computerKey: base64Url.encode(List<int>.filled(32, 7)).replaceAll('=', ''),
        name: '测试电脑',
      );

  final _FakeHost _host;

  @override
  final MobileRunCommands runCommands;

  @override
  final ComputerProfile computer;

  @override
  String get deviceId => 'phone-test';

  @override
  bool get supportsRunCommands => true;

  @override
  bool get supportsQueueCommands => false;

  @override
  bool get supportsRequestCommands => false;

  @override
  bool get supportsRunChanges => false;

  @override
  Future<MobileTimeline> openTimeline(
    String threadId, {
    TimelineSnapshot? resumeFrom,
  }) => MobileTimeline.open(_host, threadId, previous: resumeFrom);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _panePage(MobileConnection connection, {bool online = true}) =>
    ProviderScope(
      child: MaterialApp(
        theme: pigcodeTheme(Brightness.light).copyWith(
          platform: TargetPlatform.iOS,
        ),
        home: Scaffold(
          body: TimelinePane(
            connection: connection,
            threadId: _threadId,
            online: online,
            computerKey: connection.computer.computerKey,
          ),
        ),
      ),
    );

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets(
    'tightens cursorHeight and wires QQ-style keyboard send action',
    (tester) async {
      final controller = TextEditingController();
      String? submitted;
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        MaterialApp(
          theme: pigcodeTheme(Brightness.light).copyWith(
            platform: TargetPlatform.iOS,
          ),
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: MobileComposerCard(
                controller: controller,
                inputKey: const ValueKey('qq-input'),
                hintText: '回复…',
                onSubmitted: (value) => submitted = value,
                actions: const [],
              ),
            ),
          ),
        ),
      );

      final field = tester.widget<TextField>(
        find.byKey(const ValueKey('qq-input')),
      );
      expect(field.cursorHeight, ComposerControl.cursorHeight);
      expect(field.textInputAction, TextInputAction.send);
      expect(field.keyboardType, TextInputType.text);

      await tester.enterText(find.byKey(const ValueKey('qq-input')), '你好');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pump();
      expect(submitted, '你好');
    },
  );

  testWidgets(
    'clears input immediately on keyboard send, shows optimistic bubble, and reconciles without duplication',
    (tester) async {
      final gate = Completer<void>();
      final host = _FakeHost(startGate: gate);
      final connection = _FakeConnection(host);
      addTearDown(host.dispose);

      await tester.pumpWidget(_panePage(connection));
      await tester.pumpAndSettle();

      await tester.enterText(_input, '直接键盘发送');
      await tester.pump();
      await tester.testTextInput.receiveAction(TextInputAction.send);
      // 等待 journal 写入后立刻清框并挂出乐观气泡。
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 20));

      expect(tester.widget<TextField>(_input).controller!.text, isEmpty);
      expect(find.text('直接键盘发送'), findsOneWidget);
      expect(find.byKey(TimelineOptimisticUserBubble.sendingSpinnerKey), findsOneWidget);

      gate.complete();
      await tester.pumpAndSettle();
      // Host 已确认但时间线尚未推回 message.user 时，气泡仍保持可见且转圈消失。
      expect(find.text('直接键盘发送'), findsOneWidget);
      expect(find.byKey(TimelineOptimisticUserBubble.sendingSpinnerKey), findsNothing);

      // 正式事件推回后无缝接管，不出现重复气泡。
      host.emitUserEvent(runId: 'run-new', text: '直接键盘发送');
      await tester.pumpAndSettle();
      expect(find.text('直接键盘发送'), findsOneWidget);
    },
  );

  testWidgets(
    'shows red exclamation on failed send and supports resend with same commandId and delete',
    (tester) async {
      final host = _FakeHost(dropStart: true);
      final connection = _FakeConnection(host);
      addTearDown(host.dispose);

      await tester.pumpWidget(_panePage(connection));
      await tester.pumpAndSettle();

      await tester.enterText(_input, '弱网待重发');
      await tester.pump();
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      // 输入框已清空，时间线出现气泡和红色感叹号。
      expect(tester.widget<TextField>(_input).controller!.text, isEmpty);
      expect(find.text('弱网待重发'), findsOneWidget);
      expect(
        find.byKey(TimelineOptimisticUserBubble.failedBadgeKey),
        findsOneWidget,
      );
      final firstStart = host.calls.firstWhere(
        (call) => call.method == MobileCommandMethods.start,
      );

      // 点按红色感叹号，选「重新发送」，复用同一 commandId 并成功。
      host.dropStart = false;
      await tester.tap(find.byKey(TimelineOptimisticUserBubble.failedBadgeKey));
      await tester.pumpAndSettle();
      expect(find.text('消息发送未确认'), findsOneWidget);
      await tester.tap(find.text('重新发送'));
      await tester.pumpAndSettle();

      final starts = host.calls
          .where((call) => call.method == MobileCommandMethods.start)
          .toList();
      expect(starts, hasLength(2));
      expect(starts.last.params['commandId'], firstStart.params['commandId']);
      expect(
        find.byKey(TimelineOptimisticUserBubble.failedBadgeKey),
        findsNothing,
      );

      // 测试删除未确认气泡。
      host.emitUserEvent(runId: 'run-new', text: '弱网待重发');
      await tester.pumpAndSettle();
      host.dropStart = true;
      await tester.enterText(_input, '准备删掉的消息');
      await tester.pump();
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
      expect(find.text('准备删掉的消息'), findsOneWidget);

      await tester.tap(find.byKey(TimelineOptimisticUserBubble.failedBadgeKey));
      await tester.pumpAndSettle();
      await tester.tap(find.text('删除这条未发消息'));
      await tester.pumpAndSettle();
      expect(find.text('准备删掉的消息'), findsNothing);
    },
  );

  testWidgets(
    'restores rejected optimistic bubble back to input when user chooses edit',
    (tester) async {
      final host = _FakeHost(rejectStart: true);
      final connection = _FakeConnection(host);
      addTearDown(host.dispose);

      await tester.pumpWidget(_panePage(connection));
      await tester.pumpAndSettle();

      await tester.enterText(_input, '被拒绝的消息');
      await tester.pump();
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();

      expect(tester.widget<TextField>(_input).controller!.text, isEmpty);
      expect(find.text('被拒绝的消息'), findsOneWidget);
      expect(find.text('会话已有运行中的一轮。'), findsOneWidget);

      await tester.tap(find.byKey(TimelineOptimisticUserBubble.failedBadgeKey));
      await tester.pumpAndSettle();
      await tester.tap(find.text('放回输入框编辑'));
      await tester.pumpAndSettle();

      expect(tester.widget<TextField>(_input).controller!.text, '被拒绝的消息');
      expect(
        find.byKey(TimelineOptimisticUserBubble.failedBadgeKey),
        findsNothing,
      );
    },
  );

  testWidgets(
    'MobileGlassSurface uses native UIGlassEffect when supported and falls back cleanly',
    (tester) async {
      addTearDown(() => MobileNativeGlass.instance.setSupportedForTest(false));
      MobileNativeGlass.instance.setSupportedForTest(false);

      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: Center(
              child: MobileGlassSurface(
                child: SizedBox(width: 44, height: 44),
              ),
            ),
          ),
        ),
      );
      expect(find.byType(BackdropFilter), findsOneWidget);
      expect(find.byType(UiKitView), findsNothing);

      MobileNativeGlass.instance.setSupportedForTest(true);
      await tester.pump();
      expect(find.byType(UiKitView), findsOneWidget);
      expect(find.byType(BackdropFilter), findsNothing);

      await tester.pumpWidget(
        const MaterialApp(
          home: MediaQuery(
            data: MediaQueryData(highContrast: true),
            child: Scaffold(
              body: Center(
                child: MobileGlassSurface(
                  child: SizedBox(width: 44, height: 44),
                ),
              ),
            ),
          ),
        ),
      );
      expect(find.byType(BackdropFilter), findsNothing);
      expect(find.byType(UiKitView), findsNothing);
    },
  );

  testWidgets('keeps glass surface on offline MobileComposerCard when glass is enabled', (
    tester,
  ) async {
    addTearDown(() => MobileNativeGlass.instance.setSupportedForTest(false));
    MobileNativeGlass.instance.setSupportedForTest(true);
    final controller = TextEditingController();
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        theme: pigcodeTheme(Brightness.light).copyWith(
          platform: TargetPlatform.iOS,
        ),
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: MobileComposerCard(
              controller: controller,
              hintText: '电脑离线，消息发不出去',
              offline: true,
              glass: true,
              actions: const [],
            ),
          ),
        ),
      ),
    );

    expect(find.byType(MobileGlassSurface), findsOneWidget);
    expect(find.byType(UiKitView), findsOneWidget);
  });
}
