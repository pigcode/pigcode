import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/request_input.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

const _approval = MobileTimelinePending(
  id: 'approval',
  kind: MobileTimelinePendingKind.approval,
);
const _question = MobileTimelinePending(
  id: 'question',
  kind: MobileTimelinePendingKind.question,
);
final _composer = find.byKey(const ValueKey('message-input'));

class _RequestHost implements HostRequests {
  final calls = <({String method, Map<String, Object?> params})>[];
  bool loseReply = false;
  bool singleQuestion = false;

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: params));
    if (method == MobileCommandMethods.receipt) return <String, dynamic>{};
    final threadId = params['threadId'] as String;
    final runId = params['runId'] as String;
    final requestId = params['requestId'] as String;
    if (method == MobileRequestMethods.details) {
      return MobileRequestDetails(
        threadId: threadId,
        runId: runId,
        requestId: requestId,
        approval: requestId == 'approval'
            ? const MobileApproval(
                toolName: 'Bash',
                title: '允许验收命令？',
                detail: 'echo ready',
                decisions: [
                  MobileApprovalDecision.allowOnce,
                  MobileApprovalDecision.deny,
                ],
              )
            : null,
        questions: requestId == 'question'
            ? [
                if (!singleQuestion)
                  const MobileQuestion(
                    question: '覆盖哪些平台？',
                    options: [
                      MobileQuestionOption(label: 'iOS'),
                      MobileQuestionOption(label: 'Android'),
                    ],
                    multiSelect: true,
                    allowCustomAnswer: false,
                  ),
                const MobileQuestion(
                  question: '如何验收？',
                  options: [MobileQuestionOption(label: '本机')],
                  multiSelect: false,
                  allowCustomAnswer: true,
                ),
              ]
            : null,
      ).toJson();
    }
    if (loseReply) throw const ConnectionFailure('closed');
    final approval = method == MobileRequestMethods.approve;
    return MobileRequestReceipt(
      threadId: threadId,
      runId: runId,
      requestId: requestId,
      commandId: params['commandId'] as String,
      method: MobileRequestMethod.fromWire(method),
      outcome: approval
          ? const MobileRequestOutcome(
              state: MobileRequestState.alreadyHandled,
              decision: MobileApprovalDecision.deny,
            )
          : const MobileRequestOutcome(
              state: MobileRequestState.applied,
              answers: ['iOS, Android', '模拟器'],
            ),
    ).toJson();
  }
}

class _Connection implements MobileConnection {
  _Connection(_RequestHost host)
    : pendingRequests = MobilePendingRequests(host);

  @override
  final MobilePendingRequests pendingRequests;
  @override
  final computer = ComputerProfile(
    address: 'wss://localhost/ws/v1/connect',
    token: 'fixture',
    computerKey: base64Url.encode(List<int>.filled(32, 1)).replaceAll('=', ''),
    name: '测试电脑',
  );
  @override
  String get deviceId => 'fixture-phone';

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _page(
  MobileConnection connection,
  List<MobileTimelinePending> pending, {
  bool online = true,
  VoidCallback? onStop,
}) => ProviderScope(
  child: MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: RequestInput(
          connection: connection,
          threadId: 'thread',
          online: online,
          onStop: onStop,
          live: MobileActiveRun(
            runId: 'run',
            startedAt: '2026-11-23T01:00:00.000Z',
            revision: 0,
            text: '',
            textTruncated: false,
            reasoning: '',
            reasoningTruncated: false,
            tools: const [],
            pending: pending,
          ),
          composer: const TextField(
            key: ValueKey('message-input'),
            decoration: InputDecoration(hintText: '发消息'),
          ),
        ),
      ),
    ),
  ),
);

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets('keeps a single answer editable until it is submitted', (
    tester,
  ) async {
    final host = _RequestHost()..singleQuestion = true;
    var stopCount = 0;
    await tester.pumpWidget(
      _page(_Connection(host), [_question], onStop: () => stopCount++),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('停止本轮运行'));
    expect(stopCount, 1);
    final submit = find.widgetWithText(FilledButton, '回答');
    expect(tester.widget<FilledButton>(submit).onPressed, isNull);
    await tester.tap(find.text('本机'));
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);
    expect(
      host.calls.where((call) => call.method == MobileRequestMethods.answer),
      isEmpty,
    );
    await tester.enterText(find.byKey(const ValueKey('other-answer-0')), '模拟器');
    await tester.pumpAndSettle();
    await tester.tap(submit);
    await tester.pumpAndSettle();
    expect(host.calls.last.params['answers'], [
      {'selected': [], 'custom': '模拟器'},
    ]);
  });

  testWidgets(
    'shows the actual decision and restores the draft after the last request',
    (tester) async {
      final host = _RequestHost();
      final phone = _Connection(host);
      await tester.pumpWidget(_page(phone, []));
      await tester.pumpAndSettle();
      await tester.enterText(_composer, '原来的草稿');

      await tester.pumpWidget(_page(phone, [_approval, _question]));
      await tester.pumpAndSettle();
      expect(_composer, findsNothing);
      expect(find.text('允许验收命令？'), findsOneWidget);
      expect(find.text('echo ready'), findsOneWidget);
      expect(find.text('还有 1 项待处理'), findsOneWidget);
      expect(find.text('这个会话里都允许'), findsNothing);
      await tester.tap(find.text('允许本次'));
      await tester.pumpAndSettle();
      expect(find.text('另一端已处理 · 已拒绝'), findsOneWidget);
      expect(
        host.calls
            .singleWhere((call) => call.method == MobileRequestMethods.approve)
            .params,
        containsPair('decision', 'allow-once'),
      );

      await tester.pumpWidget(_page(phone, [_question]));
      await tester.pumpAndSettle();
      expect(_composer, findsNothing);
      expect(find.text('允许验收命令？'), findsNothing);
      expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, '提交回答'))
            .onPressed,
        isNull,
      );
      await tester.tap(find.text('iOS'));
      await tester.tap(find.text('Android'));
      final other = find.byKey(const ValueKey('other-answer-1'));
      await tester.enterText(other, '旧的自填答案');
      await tester.ensureVisible(find.text('本机'));
      await tester.tap(find.text('本机'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextFormField>(other).controller!.text, isEmpty);

      await tester.enterText(other, '字' * 17000);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('提交回答'));
      await tester.tap(find.text('提交回答'));
      await tester.pumpAndSettle();
      expect(find.text('回答太长，请缩短后提交。'), findsOneWidget);
      expect(
        host.calls.where((call) => call.method == MobileRequestMethods.answer),
        isEmpty,
      );

      await tester.enterText(other, '模拟器');
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('提交回答'));
      await tester.tap(find.text('提交回答'));
      await tester.pumpAndSettle();
      expect(host.calls.last.params['answers'], [
        {
          'selected': ['iOS', 'Android'],
        },
        {'selected': [], 'custom': '模拟器'},
      ]);

      await tester.pumpWidget(_page(phone, []));
      await tester.pumpAndSettle();
      expect(_composer, findsOneWidget);
      expect(find.text('原来的草稿'), findsOneWidget);
      expect(find.text('覆盖哪些平台？'), findsNothing);
    },
  );

  testWidgets(
    'checks the receipt before retrying with the exact saved decision',
    (tester) async {
      final host = _RequestHost()..loseReply = true;
      final phone = _Connection(host);
      await tester.pumpWidget(_page(phone, [_approval]));
      await tester.pumpAndSettle();
      await tester.tap(find.text('允许本次'));
      await tester.pumpAndSettle();
      final first = host.calls.last;
      expect(first.method, MobileRequestMethods.approve);
      expect(
        tester
            .widget<OutlinedButton>(find.widgetWithText(OutlinedButton, '拒绝'))
            .onPressed,
        isNull,
      );

      await tester.pumpWidget(_page(phone, [_approval], online: false));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, '用原编号重试'))
            .onPressed,
        isNull,
      );

      host.loseReply = false;
      await tester.pumpWidget(_page(phone, [_approval]));
      await tester.pumpAndSettle();
      await tester.tap(find.text('用原编号重试'));
      await tester.pumpAndSettle();
      expect(
        host.calls[host.calls.length - 2].method,
        MobileCommandMethods.receipt,
      );
      expect(host.calls.last.params, first.params);
      expect(find.text('另一端已处理 · 已拒绝'), findsOneWidget);
    },
  );
}
