import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/mobile_secure_storage.dart';
import 'package:pigcode_mobile/offline_cache.dart';
import 'package:pigcode_mobile/workspace.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

final _profile = ComputerProfile(
  address: 'wss://localhost/ws/v1/connect',
  token: 'fixture',
  computerKey: base64Url.encode(List<int>.filled(32, 4)).replaceAll('=', ''),
  name: '离线电脑',
);

class _SavedCache implements ComputerOfflineCache {
  final time = DateTime.utc(2026, 11, 23, 7);

  @override
  Future<SidebarSnapshot> readSidebar() async => SidebarSnapshot(
    projects: const [MobileProjectSummary(id: 'project', name: '本地项目')],
    threads: const [
      MobileThreadSummary(
        id: 'thread',
        projectId: 'project',
        title: '缓存会话',
        updatedAt: '2026-11-23T07:00:00.000Z',
        archived: false,
        pinned: false,
        status: MobileThreadStatus.waitingApproval,
        unread: true,
      ),
    ],
    syncedAt: time,
  );

  @override
  Future<CachedTimeline?> readTimeline(String threadId) async =>
      threadId != 'thread'
      ? null
      : CachedTimeline(
          TimelineSnapshot(
            events: const [
              MobileTimelineEvent(
                seq: 1,
                kind: MobileTimelineKind.messageAssistant,
                createdAt: '2026-11-23T07:00:00.000Z',
                text: '上次加载的内容',
              ),
            ],
            through: 1,
            cursor: 1,
            nextBefore: 1,
            live: null,
          ),
          time,
        );

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _workspace({bool hasCache = true, String connectionLabel = '电脑离线'}) =>
    ProviderScope(
      child: MaterialApp(
        home: MobileWorkspace(
          connection: null,
          connected: false,
          connectionLabel: connectionLabel,
          onComputers: () {},
          reconnect: () {},
          computer: _profile,
          deviceId: 'fixture-phone',
          cache: hasCache ? _SavedCache() : null,
        ),
      ),
    );

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  testWidgets(
    'cold start opens cached history and restores a thread draft without a connection',
    (tester) async {
      await tester.pumpWidget(_workspace());
      await tester.pumpAndSettle();
      expect(find.text('缓存会话'), findsWidgets);
      expect(find.text('上次加载的内容'), findsOneWidget);
      expect(find.textContaining('上次同步'), findsWidgets);

      final input = find.byKey(const ValueKey('run-composer-input'));
      await tester.enterText(input, '离线时写的文字');
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<IconButton>(
              find.byWidgetPredicate(
                (widget) => widget is IconButton && widget.tooltip == '发送消息',
              ),
            )
            .onPressed,
        isNull,
      );

      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      await tester.pumpWidget(_workspace());
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(input).controller?.text, '离线时写的文字');
    },
  );

  testWidgets(
    'restores a preexisting new-thread draft offline even before saving a sidebar',
    (tester) async {
      await mobileSecureStorage.write(
        key:
            'pigcode.mobile.new-thread.v1.${_profile.computerKey}.fixture-phone',
        value: jsonEncode({
          'form': {
            'text': '还没发出的首条消息',
            'projectId': 'project',
            'instanceId': 'agent-id',
            'instanceLabel': '原来的 Agent',
            'modelId': 'model-id',
            'modelLabel': '原来的模型',
            'permissionMode': MobileDraftPermission.values.first.wire,
          },
          'pending': null,
        }),
      );
      await tester.pumpWidget(_workspace(hasCache: false));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      expect(find.text('已选项目'), findsOneWidget);
      expect(find.text('原来的 Agent'), findsOneWidget);
      expect(find.text('原来的模型'), findsOneWidget);
      final editor = find.byKey(const ValueKey('first-message-input'));
      expect(tester.widget<TextField>(editor).controller?.text, '还没发出的首条消息');
      await tester.enterText(editor, '离线修改的首条消息');
      await tester.pumpAndSettle();

      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      await tester.pumpWidget(_workspace(hasCache: false));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      expect(tester.widget<TextField>(editor).controller?.text, '离线修改的首条消息');
      expect(find.text('原来的模型'), findsOneWidget);
    },
  );

  testWidgets('compacts long connection error sentences in the header badge', (
    tester,
  ) async {
    expect(compactConnectionBadgeLabel('电脑离线'), '电脑离线');
    expect(compactConnectionBadgeLabel('电脑离线 · 最后在线 01:22'), '电脑离线');
    expect(compactConnectionBadgeLabel('连不上中继，请检查网络。'), '连不上中继');
    expect(compactConnectionBadgeLabel('正在连接电脑…'), '连接中…');
    expect(compactConnectionBadgeLabel('电脑上的 Pigcode 已退出'), '电脑已退出');
    expect(compactConnectionBadgeLabel('电脑上的 Pigcode 正在重启'), '电脑重启中');

    await tester.pumpWidget(_workspace(connectionLabel: '连不上中继，请检查网络。'));
    await tester.pumpAndSettle();
    expect(find.text('连不上中继'), findsOneWidget);
  });
}
