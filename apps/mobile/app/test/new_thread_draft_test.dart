import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/new_thread_draft.dart';
import 'package:pigcode_mobile/workspace.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

final _input = find.byKey(const ValueKey('first-message-input'));
final _send = find.widgetWithIcon(IconButton, Icons.arrow_upward);

const _projects = [
  MobileProjectSummary(id: 'one', name: '主项目'),
  MobileProjectSummary(id: 'two', name: '次要项目'),
];
const _threads = [
  MobileThreadSummary(
    id: 'existing',
    projectId: 'one',
    title: '原来的会话',
    updatedAt: '2026-11-23T00:00:00.000Z',
    archived: false,
    pinned: false,
    status: MobileThreadStatus.idle,
    unread: false,
  ),
  MobileThreadSummary(
    id: 'existing-two',
    projectId: 'two',
    title: '次要项目的会话',
    updatedAt: '2026-11-22T22:00:00.000Z',
    archived: false,
    pinned: false,
    status: MobileThreadStatus.idle,
    unread: false,
  ),
];

class _DraftHost implements HostRequests {
  final writes = <Map<String, Object?>>[];
  final lookups = <String>[];
  bool reject = false;
  bool loseReply = false;
  bool receiptUnavailable = false;
  String defaultInstance = 'default';
  String defaultModel = 'sage';
  MobileDraftReceipt? accepted;

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    switch (method) {
      case MobileDraftMethods.options:
        return MobileDraftOptions(
          defaultInstanceId: defaultInstance,
          instances: const [
            MobileDraftInstance(
              instanceId: 'default',
              label: '默认实例',
              agentName: 'Fake',
              permissionModes: [MobileDraftPermission.approvalRequired],
              defaultPermissionMode: MobileDraftPermission.approvalRequired,
            ),
            MobileDraftInstance(
              instanceId: 'other',
              label: '团队实例',
              agentName: 'Fake',
              permissionModes: [
                MobileDraftPermission.approvalRequired,
                MobileDraftPermission.autoAcceptEdits,
              ],
              defaultPermissionMode: MobileDraftPermission.approvalRequired,
            ),
          ],
        ).toJson();
      case MobileDraftMethods.models:
        return MobileDraftModels(
          models: const [
            MobileDraftModel(id: 'sage', label: 'Sage 模型'),
            MobileDraftModel(id: 'swift', label: 'Swift 模型'),
          ],
          defaultModelId: defaultModel,
        ).toJson();
      case MobileDraftMethods.create:
        writes.add(params);
        if (reject) {
          throw const MobileRpcFailure(
            MobileRpcProblem(
              code: 'DRAFT_SELECTION_UNAVAILABLE',
              message: '草稿选中的设置已不可用。',
              retryable: false,
            ),
          );
        }
        if (loseReply) throw const ConnectionFailure('closed');
        final result = MobileDraftReceipt(
          method: MobileDraftMethods.create,
          commandId: params['commandId'] as String,
          projectId: params['projectId'] as String,
          threadId: 'created',
          title: params['text'] as String,
          runId: 'first-run',
        );
        accepted = result;
        return result.toJson();
      case MobileCommandMethods.receipt:
        lookups.add(params['commandId'] as String);
        if (receiptUnavailable) {
          throw const MobileRpcFailure(
            MobileRpcProblem(
              code: 'RESOURCE_NOT_AVAILABLE',
              message: '原会话已不可访问。',
              retryable: false,
            ),
          );
        }
        return MobileDraftReceiptResult(receipt: accepted).toJson();
      default:
        throw StateError('Unexpected method: $method');
    }
  }
}

class _Connection implements MobileConnection {
  _Connection(_DraftHost host) : drafts = MobileDraftCommands(host);

  @override
  final MobileDraftCommands drafts;
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

Widget _page(_Connection phone) => ProviderScope(
  child: MaterialApp(
    home: WorkspaceView(
      computerName: '测试电脑',
      online: true,
      onComputers: () {},
      snapshot: SidebarSnapshot(
        projects: _projects,
        threads: _threads,
        syncedAt: DateTime.utc(2026, 11, 23),
      ),
      timeline: (thread, _, _, _) => Center(child: Text('已打开 ${thread.id}')),
      draft: (projectId, fallbackProjectId, onAccepted, onProjectNameChanged) =>
          NewThreadDraft(
            connection: phone,
            projects: _projects,
            projectId: projectId,
            fallbackProjectId: fallbackProjectId,
            online: true,
            onAccepted: onAccepted,
            onProjectNameChanged: onProjectNameChanged,
          ),
    ),
  ),
);

Future<void> _pick(WidgetTester tester, String field, String option) async {
  await tester.tap(find.byTooltip(field));
  await tester.pumpAndSettle();
  await tester.tap(find.widgetWithText(ListTile, option).last);
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets(
    'keeps the selected project and applies a picker result across reconnect',
    (tester) async {
      final phone = _Connection(_DraftHost());
      final online = ValueNotifier(false);
      addTearDown(online.dispose);
      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            home: Scaffold(
              body: ValueListenableBuilder<bool>(
                valueListenable: online,
                builder: (_, connected, _) => NewThreadDraft(
                  connection: connected ? phone : null,
                  computerKey: phone.computer.computerKey,
                  deviceId: phone.deviceId,
                  projectId: 'one',
                  projects: _projects,
                  online: connected,
                  onAccepted: (_) {},
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await _pick(tester, '草稿项目', '次要项目');
      online.value = true;
      await tester.pumpAndSettle();
      expect(find.text('次要项目'), findsOneWidget);

      await tester.tap(find.byTooltip('草稿项目'));
      await tester.pumpAndSettle();
      online.value = false;
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ListTile, '主项目').last);
      await tester.pumpAndSettle();
      expect(find.text('主项目'), findsOneWidget);
    },
  );

  testWidgets(
    'restores text and selected settings after rejection and leaving the draft',
    (tester) async {
      final host = _DraftHost()..reject = true;
      final phone = _Connection(host);
      await tester.pumpWidget(_page(phone));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('打开菜单'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('在次要项目新建会话'));
      await tester.pumpAndSettle();
      expect(host.writes, isEmpty);
      expect(find.widgetWithText(ActionChip, '次要项目'), findsOneWidget);

      await _pick(tester, '草稿 Agent 实例', '团队实例 · Fake');
      await _pick(tester, '草稿模型', 'Swift 模型');
      await _pick(tester, '草稿权限', '接受编辑');
      await tester.enterText(_input, '保留我的第一条消息');
      await tester.pump();
      await tester.tap(_send);
      await tester.pumpAndSettle();
      expect(find.text('草稿选中的设置已不可用。'), findsOneWidget);
      expect(host.writes.single, containsPair('instanceId', 'other'));
      expect(
        host.writes.single,
        containsPair('permissionMode', 'auto-accept-edits'),
      );

      await tester.tap(find.byTooltip('返回会话'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      expect(find.text('保留我的第一条消息'), findsOneWidget);
      expect(find.widgetWithText(ActionChip, '次要项目'), findsOneWidget);
      expect(find.widgetWithText(ActionChip, 'Swift 模型'), findsOneWidget);
      expect(find.widgetWithText(ActionChip, '接受编辑'), findsOneWidget);
      expect(host.writes, hasLength(1));

      host.reject = false;
      await tester.tap(_send);
      await tester.pumpAndSettle();
      expect(host.writes.last, containsPair('projectId', 'two'));
      expect(host.writes.last, containsPair('modelId', 'swift'));
      expect(find.text('已打开 created'), findsOneWidget);
      expect(_input, findsNothing);

      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      expect(find.widgetWithText(ActionChip, '默认实例 · Fake'), findsOneWidget);
      expect(find.widgetWithText(ActionChip, 'Sage 模型'), findsOneWidget);
      expect(find.widgetWithText(ActionChip, '监督审批'), findsOneWidget);
      expect(find.text('保留我的第一条消息'), findsNothing);
    },
  );

  testWidgets(
    'checks a missing receipt and retries with the original settings and command ID',
    (tester) async {
      final host = _DraftHost()..loseReply = true;
      final phone = _Connection(host);
      await tester.pumpWidget(_page(phone));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      await tester.enterText(_input, '首发回执遗失');
      await tester.pump();
      await tester.tap(_send);
      await tester.pumpAndSettle();
      expect(find.text('首发结果待确认'), findsOneWidget);
      final original = host.writes.single;
      expect(tester.widget<IconButton>(_send).onPressed, isNull);
      await tester.enterText(_input, '另一份尚未发送的草稿');
      await tester.pumpAndSettle();

      host.loseReply = false;
      await tester.tap(find.text('用原编号重试'));
      await tester.pumpAndSettle();
      expect(host.lookups, [original['commandId']]);
      expect(host.writes, [original, original]);
      expect(find.text('已打开 created'), findsOneWidget);

      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      expect(find.text('另一份尚未发送的草稿'), findsOneWidget);
      expect(host.writes, hasLength(2));
    },
  );

  testWidgets(
    'a project shortcut resolves a prior submission before preselecting another project',
    (tester) async {
      final host = _DraftHost()..loseReply = true;
      final phone = _Connection(host);
      await tester.pumpWidget(_page(phone));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      await tester.enterText(_input, '原项目的首条消息');
      await tester.pump();
      await tester.tap(_send);
      await tester.pumpAndSettle();
      final original = host.writes.single;
      expect(original['projectId'], 'one');
      host.accepted = MobileDraftReceipt(
        method: MobileDraftMethods.create,
        commandId: original['commandId'] as String,
        projectId: 'one',
        threadId: 'created',
        title: '原项目的首条消息',
        runId: 'first-run',
      );

      await tester.tap(find.byTooltip('返回会话'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('打开菜单'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('在次要项目新建会话'));
      await tester.pumpAndSettle();
      expect(find.text('已打开 created'), findsOneWidget);
      expect(host.writes, hasLength(1));
      expect(host.lookups, [original['commandId']]);

      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<EditableText>(
              find.descendant(of: _input, matching: find.byType(EditableText)),
            )
            .controller
            .text,
        isEmpty,
      );
      expect(tester.widget<IconButton>(_send).onPressed, isNull);
    },
  );

  testWidgets(
    'keeps the displayed draft choices across a changed conversation and defaults',
    (tester) async {
      final host = _DraftHost();
      final phone = _Connection(host);
      await tester.pumpWidget(_page(phone));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      await tester.enterText(_input, '原有草稿');
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('返回会话'));
      await tester.pumpAndSettle();
      host.defaultInstance = 'other';
      host.defaultModel = 'swift';

      await tester.tap(find.byTooltip('打开菜单'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('次要项目的会话'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      expect(find.text('原有草稿'), findsOneWidget);
      expect(find.widgetWithText(ActionChip, '主项目'), findsOneWidget);
      expect(find.widgetWithText(ActionChip, '默认实例 · Fake'), findsOneWidget);
      expect(find.widgetWithText(ActionChip, 'Sage 模型'), findsOneWidget);
      expect(host.writes, isEmpty);
    },
  );

  testWidgets(
    'a stored receipt for a removed project releases the pending slot',
    (tester) async {
      final host = _DraftHost()..loseReply = true;
      final phone = _Connection(host);
      await tester.pumpWidget(_page(phone));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      await tester.enterText(_input, '已发送到原项目');
      await tester.pump();
      await tester.tap(_send);
      await tester.pumpAndSettle();
      expect(find.text('首发结果待确认'), findsOneWidget);

      host.receiptUnavailable = true;
      host.loseReply = false;
      await tester.tap(find.text('查回执'));
      await tester.pumpAndSettle();
      expect(find.text('首发已受理，原会话暂不可访问。'), findsOneWidget);
      expect(find.text('首发结果待确认'), findsNothing);
      expect(tester.widget<IconButton>(_send).onPressed, isNull);
      expect(host.writes, hasLength(1));

      await _pick(tester, '草稿项目', '次要项目');
      await tester.enterText(_input, '另一个项目的新消息');
      await tester.pump();
      await tester.tap(_send);
      await tester.pumpAndSettle();
      expect(host.writes, hasLength(2));
      expect(host.writes.last, containsPair('projectId', 'two'));
      expect(
        host.writes.last['commandId'],
        isNot(host.writes.first['commandId']),
      );
    },
  );
}
