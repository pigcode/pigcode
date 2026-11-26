import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/computers_hub.dart';
import 'package:pigcode_mobile/multi_computer_summary.dart';
import 'package:pigcode_mobile/offline_cache.dart';
import 'package:pigcode_mobile/sidebar_menu.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

ComputerProfile _profile(String suffix, String name) {
  final key = base64Url
      .encode(List<int>.filled(32, suffix.codeUnitAt(0)))
      .replaceAll('=', '');
  return ComputerProfile(
    computerKey: key,
    name: name,
    address: 'wss://relay.example.com/ws/v1/connect',
    token: 'tok-$suffix',
  );
}

MobileComputerSummary _summary({
  required String hexChar,
  required String name,
  required List<MobileSummaryItem> items,
  int working = 0,
}) {
  final now = DateTime.now().toUtc();
  return MobileComputerSummary(
    computerId: hexChar * 64,
    computerName: name,
    syncedAt: now,
    counts: MobileSummaryCounts(
      attention: items.where((i) => i.isAttention).length,
      error: items.where((i) => i.isError).length,
      unread: items.where((i) => i.isUnread).length,
      working: working,
      total: items.length + working,
    ),
    items: items,
    truncated: false,
  );
}

OfflineCacheStore _noDiskCacheStore() => OfflineCacheStore(
  directory: () => Future.error(MissingPluginException('no disk in test')),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late NoiseIdentity identity;

  setUp(() async {
    identity = await NoiseIdentity.create();
  });

  testWidgets('空状态展示配对引导卡并触发扫码', (tester) async {
    final coordinator = MultiComputerCoordinator(
      cacheStore: _noDiskCacheStore(),
      observeStatus: (_) async => throw const ConnectionFailure('incompatible'),
    );
    addTearDown(coordinator.dispose);
    var scanned = false;

    await tester.pumpWidget(
      MaterialApp(
        theme: pigcodeTheme(Brightness.light),
        home: ComputersHub(
          coordinator: coordinator,
          loadingComputers: false,
          computersError: false,
          onRetryComputers: () {},
          selectedComputerKey: null,
          activeConnectionLabel: '连接已断开',
          working: false,
          updatingRelay: false,
          verificationCode: null,
          feedback: null,
          deviceNumber: 'AABBCCDD',
          version: '0.1.0',
          onBackToWorkspace: null,
          onOpenReminderSettings: () {},
          onRefreshAll: () async {},
          onRefreshComputer: (_) async {},
          onSelectComputer: (_) {},
          onOpenInboxItem: (_) {},
          onForgetComputer: (_) {},
          onScanPair: () => scanned = true,
        ),
      ),
    );

    expect(find.text('连接你的电脑'), findsOneWidget);
    expect(find.text('扫码配对电脑'), findsOneWidget);
    expect(find.textContaining('AABBCCDD'), findsOneWidget);

    await tester.tap(find.byKey(ComputersHub.scanButtonKey));
    await tester.pump();
    expect(scanned, isTrue);
  });

  testWidgets('跨电脑汇总展示排序、双维筛选、离线缓存标记、点击直达及电脑操作弹层', (tester) async {
    final macBook = _profile('a', 'MacBook Pro');
    final macMini = _profile('b', 'Mac mini');
    final nas = _profile('c', 'Home NAS');

    final coordinator = MultiComputerCoordinator(
      cacheStore: _noDiskCacheStore(),
      observeStatus: (_) async => throw const ConnectionFailure('incompatible'),
      fetchSummary: (computer, _) async {
        if (computer.computerKey == macMini.computerKey) {
          return _summary(
            hexChar: 'b',
            name: 'Mac mini',
            working: 1,
            items: [
              MobileSummaryItem(
                threadId: 't-mini-approve',
                projectId: 'p-mini',
                projectName: 'relay-go',
                title: '灰度发布审批',
                updatedAt: DateTime.now().toUtc().toIso8601String(),
                status: MobileThreadStatus.waitingApproval,
                pendingKind: MobileThreadPendingKind.approval,
                pendingPreview: '等待审批 · 部署脚本',
                unread: true,
                pinned: false,
              ),
              MobileSummaryItem(
                threadId: 't-mini-unread',
                projectId: 'p-mini',
                projectName: 'relay-go',
                title: '压测报告已出',
                updatedAt: DateTime.now()
                    .toUtc()
                    .subtract(const Duration(minutes: 5))
                    .toIso8601String(),
                status: MobileThreadStatus.completed,
                unread: true,
                pinned: false,
              ),
            ],
          );
        }
        if (computer.computerKey == nas.computerKey) {
          // Home NAS 仅有摘要、不在线 -> 展示「缓存」离线标记
          return _summary(
            hexChar: 'c',
            name: 'Home NAS',
            items: [
              MobileSummaryItem(
                threadId: 't-nas-err',
                projectId: 'p-nas',
                projectName: 'backup-job',
                title: '夜间备份脚本失败',
                updatedAt: DateTime.now().toUtc().toIso8601String(),
                status: MobileThreadStatus.failed,
                unread: false,
                pinned: false,
              ),
            ],
          );
        }
        throw const ConnectionFailure('offline');
      },
    );
    addTearDown(coordinator.dispose);

    coordinator.updateComputers([macBook, macMini, nas], identity: identity);
    coordinator.setActiveComputer(
      computerKey: macBook.computerKey,
      connected: true,
      summary: _summary(
        hexChar: 'a',
        name: 'MacBook Pro',
        items: [
          MobileSummaryItem(
            threadId: 't-mb-question',
            projectId: 'p-mb',
            projectName: 'pigcode',
            title: '确认交互细节',
            updatedAt: DateTime.now()
                .toUtc()
                .subtract(const Duration(minutes: 2))
                .toIso8601String(),
            status: MobileThreadStatus.waitingApproval,
            pendingKind: MobileThreadPendingKind.question,
            pendingPreview: '选择默认筛选维度？',
            unread: false,
            pinned: false,
          ),
        ],
      ),
    );
    await coordinator.refreshComputer(macMini.computerKey, force: true);
    await coordinator.refreshComputer(nas.computerKey, force: true);
    await tester.pump();

    CrossComputerInboxItem? openedItem;
    ComputerProfile? forgotten;

    await tester.pumpWidget(
      MaterialApp(
        theme: pigcodeTheme(Brightness.light),
        home: ComputersHub(
          coordinator: coordinator,
          loadingComputers: false,
          computersError: false,
          onRetryComputers: () {},
          selectedComputerKey: macBook.computerKey,
          activeConnectionLabel: '已连接',
          working: false,
          updatingRelay: false,
          verificationCode: null,
          feedback: null,
          deviceNumber: '11223344',
          version: '0.1.0',
          onBackToWorkspace: () {},
          onOpenReminderSettings: () {},
          onRefreshAll: () => coordinator.refreshAll(force: true),
          onRefreshComputer: (c) =>
              coordinator.refreshComputer(c.computerKey, force: true),
          onSelectComputer: (_) {},
          onOpenInboxItem: (item) => openedItem = item,
          onForgetComputer: (c) => forgotten = c,
          onScanPair: () {},
        ),
      ),
    );
    await tester.pumpAndSettle();

    // 顶部状态头与所有待看条目
    expect(find.text('2 项等待处理'), findsOneWidget);
    expect(find.text('灰度发布审批'), findsOneWidget);
    expect(find.text('等待审批 · 部署脚本'), findsOneWidget);
    expect(find.text('确认交互细节'), findsOneWidget);
    expect(find.text('选择默认筛选维度？'), findsOneWidget);
    expect(find.text('夜间备份脚本失败'), findsOneWidget);
    expect(find.text('缓存'), findsWidgets);

    // 按「出错」筛选
    await tester.tap(find.byKey(ComputersHub.filterErrorKey));
    await tester.pumpAndSettle();
    expect(find.text('夜间备份脚本失败'), findsOneWidget);
    expect(find.text('灰度发布审批'), findsNothing);

    // 切回「全部待看」再按电脑范围筛选「Mac mini」
    await tester.tap(find.byKey(ComputersHub.filterAllKey));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(ValueKey('scope-${macMini.computerKey}')));
    await tester.pumpAndSettle();
    expect(find.text('灰度发布审批'), findsOneWidget);
    expect(find.text('压测报告已出'), findsOneWidget);
    expect(find.text('确认交互细节'), findsNothing);

    // 点击汇总条目直达对应电脑和会话
    await tester.tap(
      find.byKey(ValueKey('inbox-${macMini.computerKey}-t-mini-approve')),
    );
    await tester.pump();
    expect(openedItem?.computer.computerKey, macMini.computerKey);
    expect(openedItem?.item.threadId, 't-mini-approve');

    // 打开电脑卡片操作弹层并触发移除
    final verticalScrollable = find
        .descendant(
          of: find.byKey(ComputersHub.listViewKey),
          matching: find.byType(Scrollable),
        )
        .first;
    await tester.scrollUntilVisible(
      find.byKey(ValueKey('computer-more-${nas.computerKey}')),
      200,
      scrollable: verticalScrollable,
    );
    await tester.tap(find.byKey(ValueKey('computer-more-${nas.computerKey}')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('移除这台电脑'));
    await tester.pumpAndSettle();
    expect(forgotten?.computerKey, nas.computerKey);
  });

  testWidgets('深色模式下被撤销的电脑展示卡片内联恢复操作且不干扰其他电脑', (tester) async {
    final activePc = _profile('d', 'Studio');
    final revokedPc = _profile('e', 'Office PC');
    var rescanned = false;
    ComputerProfile? removed;

    final coordinator = MultiComputerCoordinator(
      cacheStore: _noDiskCacheStore(),
      observeStatus: (_) async => throw const ConnectionFailure('incompatible'),
      fetchSummary: (_, _) async =>
          throw const ConnectionFailure('device-revoked'),
    );
    addTearDown(coordinator.dispose);

    coordinator.updateComputers([activePc, revokedPc], identity: identity);
    coordinator.setActiveComputer(
      computerKey: activePc.computerKey,
      connected: true,
      summary: _summary(
        hexChar: 'd',
        name: 'Studio',
        working: 2,
        items: const [],
      ),
    );
    await coordinator.refreshComputer(revokedPc.computerKey, force: true);
    await tester.pump();

    await tester.pumpWidget(
      MaterialApp(
        theme: pigcodeTheme(Brightness.dark),
        home: ComputersHub(
          coordinator: coordinator,
          loadingComputers: false,
          computersError: false,
          onRetryComputers: () {},
          selectedComputerKey: activePc.computerKey,
          activeConnectionLabel: '已连接',
          working: false,
          updatingRelay: false,
          verificationCode: null,
          feedback: null,
          deviceNumber: '55667788',
          version: '0.1.0',
          onBackToWorkspace: () {},
          onOpenReminderSettings: () {},
          onRefreshAll: () async {},
          onRefreshComputer: (_) async {},
          onSelectComputer: (_) {},
          onOpenInboxItem: (_) {},
          onForgetComputer: (c) => removed = c,
          onScanPair: () => rescanned = true,
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('全部已处理'), findsOneWidget);
    expect(find.text('所有电脑暂无待处理事项'), findsOneWidget);
    expect(find.text('配对已撤销'), findsOneWidget);

    await tester.tap(find.text('重新扫码'));
    await tester.pump();
    expect(rescanned, isTrue);

    await tester.tap(find.text('移除'));
    await tester.pump();
    expect(removed?.computerKey, revokedPc.computerKey);
  });

  testWidgets('侧栏底部电脑胶囊仅在其他电脑有紧急待办时显示计数徽标', (tester) async {
    final focusNode = FocusNode();
    addTearDown(focusNode.dispose);

    Widget buildSidebar(int urgentCount) => MaterialApp(
      theme: pigcodeTheme(Brightness.light),
      home: Scaffold(
        body: SizedBox(
          width: 320,
          child: SidebarMenu(
            snapshot: SidebarSnapshot(
              projects: const [MobileProjectSummary(id: 'p1', name: 'demo')],
              threads: const [],
              syncedAt: DateTime.utc(2026, 11, 26),
            ),
            selectedId: null,
            computerName: 'MacBook Pro',
            online: true,
            connectionLabel: '已连接',
            onSelect: (_) {},
            onComputers: () {},
            focusNode: focusNode,
            otherComputersUrgentCount: urgentCount,
          ),
        ),
      ),
    );

    await tester.pumpWidget(buildSidebar(0));
    await tester.pumpAndSettle();
    expect(find.byKey(SidebarMenu.otherComputersBadgeKey), findsNothing);

    await tester.pumpWidget(buildSidebar(3));
    await tester.pumpAndSettle();
    expect(find.byKey(SidebarMenu.otherComputersBadgeKey), findsOneWidget);
    expect(find.text('3'), findsOneWidget);
  });
}
