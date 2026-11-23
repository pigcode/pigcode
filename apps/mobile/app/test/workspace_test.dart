import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/run_diff_screen.dart';
import 'package:pigcode_mobile/timeline_pane.dart';
import 'package:pigcode_mobile/workspace.dart';
import 'package:pigcode_mobile/sidebar_menu.dart';

import '../visual/mobile_fixture.dart';

class _ReadConnection implements MobileConnection {
  _ReadConnection(this.sidebar, {this.failFirstRead = false});

  final _Sidebar sidebar;
  final bool failFirstRead;
  int reads = 0;

  @override
  final done = Completer<void>().future;
  @override
  String get computerName => '测试电脑';
  @override
  bool get supportsSidebar => true;
  @override
  bool get supportsSidebarCommands => false;
  @override
  bool get supportsDraftCommands => false;
  @override
  bool get supportsRunCommands => false;
  @override
  bool get supportsRequestCommands => false;
  @override
  bool get supportsRunChanges => false;

  @override
  Future<MobileSidebar> openSidebar() async {
    if (++reads == 1 && failFirstRead) throw TimeoutException('sidebar');
    return sidebar;
  }

  @override
  Future<MobileTimeline> openTimeline(
    String threadId, {
    TimelineSnapshot? resumeFrom,
  }) async => _Timeline();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Sidebar implements MobileSidebar {
  _Sidebar(this.snapshot);

  @override
  final SidebarSnapshot snapshot;
  final changes = StreamController<SidebarSnapshot>.broadcast();

  @override
  Stream<SidebarSnapshot> get updates => changes.stream;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _Timeline implements MobileTimeline {
  @override
  final snapshot = TimelineSnapshot(
    events: [],
    through: 0,
    cursor: 0,
    nextBefore: null,
    live: null,
  );

  @override
  Stream<TimelineSnapshot> get updates => const Stream.empty();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

final snapshot = SidebarSnapshot(
  projects: const [
    MobileProjectSummary(id: 'one', name: '编辑器'),
    MobileProjectSummary(id: 'two', name: '文档'),
    MobileProjectSummary(id: 'empty', name: '空项目'),
  ],
  threads: const [
    MobileThreadSummary(
      id: 'newest',
      projectId: 'one',
      title: '最新会话',
      updatedAt: '2026-11-22T12:00:00.000Z',
      archived: false,
      pinned: false,
      status: MobileThreadStatus.running,
      unread: false,
    ),
    MobileThreadSummary(
      id: 'attention',
      projectId: 'one',
      title: '审批检查',
      updatedAt: '2026-11-22T11:00:00.000Z',
      archived: false,
      pinned: false,
      status: MobileThreadStatus.waitingApproval,
      unread: true,
    ),
    MobileThreadSummary(
      id: 'unread',
      projectId: 'two',
      title: '文档更新',
      updatedAt: '2026-11-22T10:00:00.000Z',
      archived: false,
      pinned: true,
      status: MobileThreadStatus.completed,
      unread: true,
    ),
    MobileThreadSummary(
      id: 'archived',
      projectId: 'two',
      title: '旧会话',
      updatedAt: '2026-11-20T10:00:00.000Z',
      archived: true,
      pinned: false,
      status: MobileThreadStatus.failed,
      unread: false,
    ),
  ],
  syncedAt: DateTime(2026, 11, 22, 20),
);

class _SidebarCommands implements MobileSidebarCommands {
  final calls = <Object>[];

  @override
  Future<void> setPinned(String threadId, bool pinned) async {
    calls.add((threadId, pinned));
  }

  @override
  Future<void> markAllRead() async {
    calls.add('markAllRead');
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget workspace({
  required bool online,
  SidebarSnapshot? data,
  double textScale = 1,
  MobileSidebarCommands? commands,
}) => MaterialApp(
  builder: (context, child) => MediaQuery(
    data: MediaQuery.of(context).copyWith(
      disableAnimations: true,
      textScaler: TextScaler.linear(textScale),
    ),
    child: child!,
  ),
  home: WorkspaceView(
    snapshot: data ?? snapshot,
    online: online,
    computerName: '测试电脑',
    sidebarCommands: commands,
    onComputers: () {},
  ),
);

Finder menuText(String label) =>
    find.descendant(of: find.byType(SidebarMenu), matching: find.text(label));

void main() {
  testWidgets('does not open a delayed diff over the sidebar', (tester) async {
    FlutterSecureStorage.setMockInitialValues({});
    final changes = Completer<MobileRunChangesPage>();
    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
          home: workspaceFixture(changedFiles: changes.future),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is IconButton &&
            widget.tooltip == '改动' &&
            widget.onPressed != null,
      ),
      findsOneWidget,
    );
    await tester.tap(find.byTooltip('改动'));
    await tester.tap(find.byTooltip('打开菜单'));
    await tester.pumpAndSettle();
    changes.complete(
      const MobileRunChangesPage(diffAvailable: true, files: []),
    );
    await tester.pumpAndSettle();
    expect(find.byType(RunDiffScreen), findsNothing);
    expect(find.byTooltip('搜索会话').hitTestable(), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('改动'));
    await tester.pumpAndSettle();
    expect(find.byType(RunDiffScreen), findsOneWidget);
  });

  testWidgets('opens search on demand and clears it when closed', (
    tester,
  ) async {
    await tester.pumpWidget(workspace(online: true));
    await tester.tap(find.byTooltip('打开菜单'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsNothing);
    await tester.tap(find.byTooltip('搜索会话'));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '审批');
    await tester.pumpAndSettle();
    expect(menuText('审批检查'), findsOneWidget);
    expect(menuText('文档更新'), findsNothing);
    await tester.tap(find.byTooltip('关闭搜索'));
    await tester.pumpAndSettle();
    expect(find.byType(TextField), findsNothing);
    expect(menuText('文档更新'), findsOneWidget);
  });

  testWidgets('shows archived sessions even when their project was collapsed', (
    tester,
  ) async {
    await tester.pumpWidget(workspace(online: true));
    await tester.tap(find.byTooltip('打开菜单'));
    await tester.pumpAndSettle();
    await tester.tap(menuText('文档').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('分组和筛选'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('只看已归档'));
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(menuText('旧会话'), findsOneWidget);
  });

  testWidgets(
    'edits sidebar state only online and keeps the pinned group in time grouping',
    (tester) async {
      final commands = _SidebarCommands();
      await tester.pumpWidget(workspace(online: true, commands: commands));
      await tester.tap(find.byTooltip('打开菜单'));
      await tester.pumpAndSettle();
      await tester.longPress(menuText('文档更新'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('取消置顶'));
      await tester.pumpAndSettle();
      expect(commands.calls, [('unread', false)]);

      await tester.tap(find.byTooltip('分组和筛选'));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(ChoiceChip, '更新时间').first);
      await tester.pumpAndSettle();
      await tester.tap(find.text('全部标为已读'));
      await tester.pumpAndSettle();
      expect(commands.calls, [('unread', false), 'markAllRead']);
      expect(menuText('置顶'), findsOneWidget);
      expect(menuText('会话'), findsOneWidget);
      expect(menuText('项目'), findsNothing);

      await tester.pumpWidget(workspace(online: false, commands: commands));
      await tester.pumpAndSettle();
      await tester.longPress(menuText('文档更新'));
      await tester.pumpAndSettle();
      expect(find.text('取消置顶'), findsNothing);
    },
  );

  testWidgets(
    'opens the recent session and filters the pushed sidebar by attention',
    (tester) async {
      await tester.pumpWidget(workspace(online: true));
      expect(find.byKey(const ValueKey('newest')), findsOneWidget);
      await tester.tap(find.byTooltip('打开菜单'));
      await tester.pumpAndSettle();

      expect(menuText('置顶'), findsOneWidget);
      expect(menuText('等你处理'), findsOneWidget);
      expect(find.bySemanticsLabel(RegExp('未读')), findsWidgets);
      expect(find.bySemanticsLabel(RegExp('运行中')), findsWidgets);
      expect(menuText('旧会话'), findsNothing);

      await tester.tap(find.byTooltip('分组和筛选'));
      await tester.pumpAndSettle();
      for (final label in ['出错', '进行中', '已完成']) {
        await tester.tap(find.widgetWithText(FilterChip, label));
        await tester.pumpAndSettle();
      }
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(menuText('最新会话'), findsNothing);
      await tester.tap(menuText('审批检查'));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('attention')), findsOneWidget);
    },
  );

  testWidgets('keeps the offline list and hides its stale markers', (
    tester,
  ) async {
    await tester.pumpWidget(workspace(online: false));
    expect(find.text('电脑连接已断开'), findsOneWidget);
    await tester.tap(find.byTooltip('打开菜单'));
    await tester.pumpAndSettle();
    expect(menuText('审批检查'), findsOneWidget);
    expect(menuText('等你处理'), findsNothing);
    expect(find.bySemanticsLabel(RegExp('未读')), findsNothing);
    expect(find.textContaining('上次同步'), findsOneWidget);
  });

  testWidgets(
    'keeps the open session when a reconnect read fails and discards the old sidebar',
    (tester) async {
      SidebarSnapshot rename(String title) => SidebarSnapshot(
        projects: snapshot.projects,
        threads: [
          MobileThreadSummary.fromJson({
            ...snapshot.threads.first.toJson(),
            'title': title,
          }),
        ],
        syncedAt: snapshot.syncedAt,
      );
      final old = _ReadConnection(_Sidebar(snapshot));
      final resumed = _ReadConnection(
        _Sidebar(rename('恢复后的会话')),
        failFirstRead: true,
      );
      addTearDown(old.sidebar.changes.close);
      addTearDown(resumed.sidebar.changes.close);
      Widget show(_ReadConnection connection) => ProviderScope(
        child: MaterialApp(
          home: MobileWorkspace(
            connection: connection,
            connected: true,
            connectionLabel: '已连接',
            reconnect: () =>
                throw TestFailure('the transport is already connected'),
            onComputers: () {},
          ),
        ),
      );

      await tester.pumpWidget(show(old));
      await tester.pumpAndSettle();
      expect(find.text('最新会话'), findsWidgets);
      final timeline = tester.element(find.byType(TimelinePane));
      await tester.pumpWidget(show(resumed));
      await tester.pumpAndSettle();
      expect(find.text('最新会话'), findsWidgets);
      expect(tester.element(find.byType(TimelinePane)), same(timeline));
      await tester.tap(find.byTooltip('重试读取会话'));
      await tester.pumpAndSettle();
      expect(resumed.reads, 2);
      expect(find.text('恢复后的会话'), findsWidgets);
      old.sidebar.changes.add(rename('旧连接的迟到列表'));
      await tester.pumpAndSettle();
      expect(find.text('恢复后的会话'), findsWidgets);
      expect(find.text('旧连接的迟到列表'), findsNothing);
    },
  );

  testWidgets(
    'keeps the selected session when another session moves to the top',
    (tester) async {
      await tester.pumpWidget(workspace(online: true));
      expect(find.byKey(const ValueKey('newest')), findsOneWidget);
      await tester.pumpWidget(
        workspace(
          online: true,
          data: SidebarSnapshot(
            projects: snapshot.projects,
            threads: [
              snapshot.threads[1],
              snapshot.threads[0],
              ...snapshot.threads.skip(2),
            ],
            syncedAt: snapshot.syncedAt,
          ),
        ),
      );
      expect(find.byKey(const ValueKey('newest')), findsOneWidget);
      expect(find.byKey(const ValueKey('attention')), findsNothing);
    },
  );

  testWidgets(
    'keeps search usable on a short viewport and finds an empty project',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(600, 240));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(workspace(online: true, textScale: 1.7));
      await tester.tap(find.byTooltip('打开菜单'));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('搜索会话'));
      await tester.pumpAndSettle();
      final search = find.descendant(
        of: find.byType(SidebarMenu),
        matching: find.byType(TextField),
      );
      await tester.enterText(search, '空项目');
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        menuText('空项目'),
        75,
        scrollable: find
            .descendant(
              of: find.byType(SidebarMenu),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(menuText('空项目'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
