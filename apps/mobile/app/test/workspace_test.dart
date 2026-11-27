import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';
import 'package:pigcode_mobile/mobile_sheet.dart';
import 'package:pigcode_mobile/multi_computer_summary.dart';
import 'package:pigcode_mobile/run_diff_screen.dart';
import 'package:pigcode_mobile/timeline_pane.dart';
import 'package:pigcode_mobile/workspace.dart';
import 'package:pigcode_mobile/workspace_icon.dart';
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
  testWidgets(
    'keeps sheet actions reachable with a short viewport and large text',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(600, 200);
      tester.view.padding = const FakeViewPadding(top: 24, bottom: 24);
      tester.view.viewPadding = tester.view.padding;
      addTearDown(tester.view.reset);
      String? action;
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: const TextScaler.linear(1.7),
              disableAnimations: true,
            ),
            child: child!,
          ),
          home: Scaffold(
            body: Center(
              child: Builder(
                builder: (context) => TextButton(
                  onPressed: () async {
                    action = await showMobileSheet<String>(
                      context,
                      title: '在放大文字的横屏窗口里查看会话操作的长标题',
                      content: (sheet) => SliverList.list(
                        children: [
                          const ListTile(title: Text('置顶')),
                          ListTile(
                            title: const Text('归档'),
                            onTap: () => Navigator.pop(sheet, 'archive'),
                          ),
                        ],
                      ),
                    );
                  },
                  child: const Text('打开会话操作'),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('打开会话操作'));
      await tester.pumpAndSettle();
      final archive = find.widgetWithText(ListTile, '归档').hitTestable();
      await tester.scrollUntilVisible(
        archive,
        40,
        scrollable: find.byType(Scrollable),
      );
      await tester.tap(archive);
      await tester.pumpAndSettle();
      expect(action, 'archive');
    },
  );

  testWidgets(
    'pushes the full page while keeping the controls in the safe area',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      tester.view.padding = const FakeViewPadding(top: 47, bottom: 34);
      tester.view.viewPadding = tester.view.padding;
      addTearDown(tester.view.reset);

      await tester.pumpWidget(workspace(online: true));
      final menu = find.byTooltip('打开菜单');
      expect(tester.getTopLeft(menu).dy, greaterThanOrEqualTo(47));
      await tester.tap(menu);
      await tester.pumpAndSettle();
      final page = tester.getRect(find.byKey(WorkspaceView.drawerPanelKey));
      expect(page.left, closeTo(390 * .84, .01));
      expect(page.top, 0);
      expect(page.bottom, 844);
    },
  );

  testWidgets(
    'supports swipe right to open drawer, swipe left to close, and standalone menus',
    (tester) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(390, 844);
      addTearDown(tester.view.reset);

      var schedulesOpened = false;
      var pluginsOpened = false;
      var agentsOpened = false;
      var projectsOpened = false;
      var switchedSheetCalled = false;

      await tester.pumpWidget(
        MaterialApp(
          home: WorkspaceView(
            snapshot: SidebarSnapshot(
              projects: snapshot.projects,
              threads: [snapshot.threads.last],
              syncedAt: snapshot.syncedAt,
            ),
            online: true,
            computerName: 'Studio Mac',
            onComputers: () {},
            onSwitchComputer: (_) => switchedSheetCalled = true,
            onOpenSchedules: () => schedulesOpened = true,
            onOpenPlugins: () => pluginsOpened = true,
            onOpenAgents: () => agentsOpened = true,
            onOpenProjects: () => projectsOpened = true,
            draft: (_, _, _, _) => const SizedBox.shrink(),
            timeline: (thread, _, _, _) => SizedBox(key: ValueKey(thread.id)),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Swipe right to open drawer smoothly.
      await tester.drag(
        find.byKey(WorkspaceView.drawerPanelKey),
        const Offset(220, 0),
      );
      await tester.pumpAndSettle();
      expect(
        tester.getRect(find.byKey(WorkspaceView.drawerPanelKey)).left,
        closeTo(390 * .84, .01),
      );

      // Verify standalone menus alongside 新会话 in SidebarMenu.
      expect(find.byKey(SidebarMenu.newThreadMenuKey), findsOneWidget);
      expect(find.byKey(SidebarMenu.schedulesMenuKey), findsOneWidget);
      expect(find.byKey(SidebarMenu.pluginsMenuKey), findsOneWidget);
      expect(find.byKey(SidebarMenu.agentsMenuKey), findsOneWidget);
      expect(find.byKey(SidebarMenu.manageProjectsButtonKey), findsOneWidget);

      await tester.tap(find.byKey(SidebarMenu.schedulesMenuKey));
      await tester.tap(find.byKey(SidebarMenu.pluginsMenuKey));
      await tester.tap(find.byKey(SidebarMenu.agentsMenuKey));
      await tester.tap(find.byKey(SidebarMenu.manageProjectsButtonKey));
      expect(schedulesOpened, isTrue);
      expect(pluginsOpened, isTrue);
      expect(agentsOpened, isTrue);
      expect(projectsOpened, isTrue);

      await tester.tap(menuText('Studio Mac'));
      expect(switchedSheetCalled, isTrue);

      // Swipe left from visible edge to close drawer smoothly.
      await tester.dragFrom(const Offset(355, 420), const Offset(-220, 0));
      await tester.pumpAndSettle();
      expect(
        tester.getRect(find.byKey(WorkspaceView.drawerPanelKey)).left,
        closeTo(0, .01),
      );
    },
  );

  testWidgets(
    'MobileWorkspace keeps sidebar open when mounted with initialMenuOpen and switches computer in place',
    (tester) async {
      FlutterSecureStorage.setMockInitialValues({});
      final macA = ComputerProfile(
        computerKey: base64Url
            .encode(List<int>.filled(32, 65))
            .replaceAll('=', ''),
        name: 'Studio Mac',
        address: 'wss://relay.example.com/ws/v1/connect',
        token: 'tok-a',
      );
      final macB = ComputerProfile(
        computerKey: base64Url
            .encode(List<int>.filled(32, 66))
            .replaceAll('=', ''),
        name: 'Mini Server',
        address: 'wss://relay.example.com/ws/v1/connect',
        token: 'tok-b',
      );
      ComputerProfile? switchedTarget;
      final conn = _ReadConnection(_Sidebar(snapshot));

      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context).copyWith(disableAnimations: true),
              child: child!,
            ),
            home: MobileWorkspace(
              connection: conn,
              connected: true,
              computer: macA,
              connectionLabel: '已连接',
              reconnect: () {},
              onComputers: () {},
              initialMenuOpen: true,
              selectedComputerKey: macA.computerKey,
              computers: [
                ComputerSummaryEntry(
                  profile: macA,
                  isActive: true,
                  activeConnected: true,
                ),
                ComputerSummaryEntry(
                  profile: macB,
                  isActive: false,
                  activeConnected: false,
                ),
              ],
              onSelectComputer: (target) => switchedTarget = target,
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Sidebar started open via initialMenuOpen.
      expect(
        find.byKey(SidebarMenu.schedulesMenuKey).hitTestable(),
        findsOneWidget,
      );

      await tester.tap(menuText('测试电脑'));
      await tester.pumpAndSettle();
      expect(find.text('切换电脑'), findsOneWidget);

      await tester.tap(
        find.byKey(ValueKey('switch-computer-${macB.computerKey}')),
      );
      await tester.pumpAndSettle();
      expect(switchedTarget?.computerKey, macB.computerKey);
    },
  );

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

  testWidgets('loads the changed-file count after a completed edit', (
    tester,
  ) async {
    FlutterSecureStorage.setMockInitialValues({});
    await tester.pumpWidget(
      ProviderScope(
        child: MaterialApp(home: workspaceFixture(completedEditOnly: true)),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.descendant(of: find.byTooltip('改动'), matching: find.text('2')),
      findsOneWidget,
    );
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

  testWidgets('keeps the sidebar header and footer visible while rows scroll', (
    tester,
  ) async {
    await tester.pumpWidget(
      workspace(
        online: true,
        data: SidebarSnapshot(
          projects: snapshot.projects,
          threads: [
            for (var index = 0; index < 24; index++)
              MobileThreadSummary.fromJson({
                ...snapshot.threads.first.toJson(),
                'id': 'sidebar-$index',
                'title': '侧栏会话 $index',
                'status': 'completed',
              }),
          ],
          syncedAt: snapshot.syncedAt,
        ),
      ),
    );
    await tester.tap(find.byTooltip('打开菜单'));
    await tester.pumpAndSettle();
    final list = find.descendant(
      of: find.byType(SidebarMenu),
      matching: find.byType(ListView),
    );
    final scrollable = find.descendant(
      of: list,
      matching: find.byType(Scrollable),
    );
    final search = find.byTooltip('搜索会话');
    final computer = menuText('测试电脑');
    final searchPosition = tester.getTopLeft(search);
    final computerPosition = tester.getTopLeft(computer);

    await tester.drag(list, const Offset(0, -300));
    await tester.pumpAndSettle();

    expect(
      tester.state<ScrollableState>(scrollable).position.pixels,
      greaterThan(0),
    );
    expect(tester.getTopLeft(search), searchPosition);
    expect(tester.getTopLeft(computer), computerPosition);
  });

  testWidgets(
    'uses the Scheme D heights for Android sidebar rows and inline buttons',
    (tester) async {
      await tester.pumpWidget(workspace(online: true));
      await tester.tap(find.byTooltip('打开菜单'));
      await tester.pumpAndSettle();

      Finder row(String title) =>
          find.ancestor(of: menuText(title), matching: find.byType(InkWell));

      expect(tester.getSize(row('最新会话')).height, 44);
      expect(tester.getSize(row('文档更新')).height, greaterThan(44));
      expect(tester.getSize(row('编辑器')).height, 44);
      // 行内按钮跟随原型的行高，触区与所在行同高，不再单独撑到 48。
      expect(tester.getSize(find.byTooltip('分组和筛选')).height, 46);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

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

    await tester.tap(find.byTooltip('分组和筛选'));
    await tester.pumpAndSettle();
    await tester.drag(find.text('只看已归档'), const Offset(-60, 0));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('关闭弹层'));
    await tester.pumpAndSettle();
    expect(menuText('旧会话'), findsNothing);
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
      await tester.tap(
        find
            .descendant(
              of: find.byType(BottomSheet),
              matching: find.text('更新时间'),
            )
            .first,
      );
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
        await tester.tap(
          find.descendant(
            of: find.byType(BottomSheet),
            matching: find.text(label),
          ),
        );
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
    expect(find.textContaining('上次同步'), findsNothing);
  });

  testWidgets('shows the agent and distinguishes approvals from questions', (
    tester,
  ) async {
    final data = SidebarSnapshot(
      projects: snapshot.projects,
      threads: [
        MobileThreadSummary.fromJson({
          ...snapshot.threads[0].toJson(),
          'status': 'completed',
          'agentName': 'Claude Code',
        }),
        MobileThreadSummary.fromJson({
          ...snapshot.threads[1].toJson(),
          'pendingKind': 'approval',
        }),
        MobileThreadSummary.fromJson({
          ...snapshot.threads[1].toJson(),
          'id': 'question',
          'title': '选项确认',
          'pendingKind': 'question',
        }),
      ],
      syncedAt: snapshot.syncedAt,
    );
    await tester.pumpWidget(workspace(online: true, data: data));
    await tester.pumpAndSettle();
    expect(find.text('编辑器 · Claude Code'), findsNothing);
    await tester.tap(find.byTooltip('会话详情'));
    await tester.pumpAndSettle();
    expect(find.text('编辑器 · Claude Code'), findsOneWidget);
    await tester.tap(find.byTooltip('关闭弹层'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('打开菜单'));
    await tester.pumpAndSettle();
    expect(menuText('等你确认'), findsOneWidget);
    expect(menuText('等你回答'), findsOneWidget);
    await tester.tap(menuText('选项确认'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('question')), findsOneWidget);
    expect(find.text('等你回答').hitTestable(), findsOneWidget);

    await tester.pumpWidget(workspace(online: false, data: data));
    await tester.pumpAndSettle();
    expect(find.text('电脑连接已断开'), findsOneWidget);
    expect(find.text('等你回答'), findsNothing);
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
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
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
      final project = find.descendant(
        of: find.byType(SidebarMenu),
        matching: find.byWidgetPredicate(
          (widget) => widget is Text && widget.data == '空项目',
        ),
      );
      await tester.scrollUntilVisible(
        project,
        75,
        scrollable: find
            .descendant(
              of: find.byType(SidebarMenu),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      expect(project, findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'single-line header opens thread actions sheet, hides empty diff button, and uses close icon on new thread',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(360, 720));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final commands = _SidebarCommands();
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: child!,
          ),
          home: WorkspaceView(
            snapshot: snapshot,
            online: true,
            computerName: '测试电脑',
            onComputers: () {},
            sidebarCommands: commands,
            draft: (_, _, _, _) => const SizedBox.shrink(),
            timeline: (thread, _, _, _) => SizedBox(key: ValueKey(thread.id)),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // 无改动时隐藏 ± 改动按钮，仅保留单圆新会话按钮。
      expect(find.byTooltip('改动'), findsNothing);
      expect(find.byTooltip('新会话'), findsOneWidget);

      // 点按单行标题打开会话详情与快捷操作弹层。
      final titleTap = find.byTooltip('会话详情');
      expect(tester.getSize(titleTap).height, greaterThanOrEqualTo(44));
      await tester.tap(titleTap);
      await tester.pumpAndSettle();
      expect(find.text('编辑器 · 生成中'), findsOneWidget);
      await tester.tap(
        find.descendant(
          of: find.byType(BottomSheet),
          matching: find.text('置顶'),
        ),
      );
      await tester.pumpAndSettle();
      expect(commands.calls, [('newest', true)]);

      // 新会话页右上角使用关闭 × 图标返回会话，且不显示重复副标题。
      await tester.tap(find.byTooltip('新会话'));
      await tester.pumpAndSettle();
      expect(find.text('新会话').hitTestable(), findsOneWidget);
      final backButton = find.byTooltip('返回会话');
      expect(backButton, findsOneWidget);
      final backIcon = tester.widget<WorkspaceIcon>(
        find.descendant(of: backButton, matching: find.byType(WorkspaceIcon)),
      );
      expect(backIcon.glyph, WorkspaceGlyph.close);
      expect(tester.takeException(), isNull);

      await tester.tap(backButton);
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('newest')), findsOneWidget);
    },
  );
}
