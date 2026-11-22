import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/workspace.dart';
import 'package:pigcode_mobile/sidebar_menu.dart';

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

Widget workspace({
  required bool online,
  SidebarSnapshot? data,
  double textScale = 1,
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
    onComputers: () {},
  ),
);

Finder menuText(String label) =>
    find.descendant(of: find.byType(SidebarMenu), matching: find.text(label));

void main() {
  testWidgets(
    'opens the recent session and filters the pushed sidebar by attention',
    (tester) async {
      await tester.pumpWidget(workspace(online: true));
      expect(find.byKey(const ValueKey('newest')), findsOneWidget);
      await tester.tap(find.byTooltip('打开菜单'));
      await tester.pumpAndSettle();

      expect(menuText('置顶'), findsOneWidget);
      expect(menuText('等你处理'), findsOneWidget);
      expect(menuText('未读'), findsOneWidget);
      expect(menuText('运行中'), findsOneWidget);
      expect(menuText('旧会话'), findsNothing);

      await tester.tap(menuText('需要处理'));
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
    expect(menuText('未读'), findsNothing);
    expect(find.textContaining('上次同步'), findsOneWidget);
  });

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
