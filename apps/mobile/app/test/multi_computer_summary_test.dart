import 'dart:convert';
import 'dart:io';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/multi_computer_summary.dart';
import 'package:pigcode_mobile/offline_cache.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

ComputerProfile _computer(String suffix, String name) {
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
  required String idHex,
  required String name,
  required DateTime syncedAt,
  required List<MobileSummaryItem> items,
  int working = 0,
  int total = 0,
}) {
  final attention = items.where((i) => i.isAttention).length;
  final error = items.where((i) => i.isError).length;
  final unread = items.where((i) => i.isUnread).length;
  return MobileComputerSummary(
    computerId: idHex * 64,
    computerName: name,
    syncedAt: syncedAt,
    counts: MobileSummaryCounts(
      attention: attention,
      error: error,
      unread: unread,
      working: working,
      total: total == 0 ? items.length + working : total,
    ),
    items: items,
    truncated: false,
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory tempDir;
  late OfflineCacheStore cacheStore;
  late NoiseIdentity identity;

  setUp(() async {
    FlutterSecureStorage.setMockInitialValues({});
    tempDir = await Directory.systemTemp.createTemp('pigcode-multi-summary-');
    cacheStore = OfflineCacheStore(directory: () async => tempDir);
    identity = await NoiseIdentity.create();
  });

  tearDown(() async {
    if (await tempDir.exists()) {
      await tempDir.delete(recursive: true);
    }
  });

  test('加密缓存按 computerKey 隔离持久化摘要且不被 saveSidebar 覆盖，clear 后彻底销毁', () async {
    final macA = _computer('a', 'MacBook Pro');
    final macB = _computer('b', 'Mac mini');
    final summaryA = _summary(
      idHex: 'a',
      name: 'MacBook Pro',
      syncedAt: DateTime.utc(2026, 11, 26, 12, 0),
      items: const [
        MobileSummaryItem(
          threadId: 't-a',
          projectId: 'p-1',
          projectName: 'pigcode',
          title: '等待审批脚本',
          updatedAt: '2026-11-26T12:00:00Z',
          status: MobileThreadStatus.waitingApproval,
          pendingKind: MobileThreadPendingKind.approval,
          pendingPreview: 'Bash · 运行测试',
          unread: true,
          pinned: false,
        ),
      ],
    );
    final summaryB = _summary(
      idHex: 'b',
      name: 'Mac mini',
      syncedAt: DateTime.utc(2026, 11, 26, 11, 0),
      items: const [],
    );

    final cacheA = cacheStore.open(macA.computerKey);
    final cacheB = cacheStore.open(macB.computerKey);
    await cacheA.saveSummary(summaryA);
    await cacheB.saveSummary(summaryB);
    // 保存空侧栏不应清理保留槽位 __summary__
    await cacheA.saveSidebar(
      SidebarSnapshot(
        projects: const [],
        threads: const [],
        syncedAt: DateTime.utc(2026, 11, 26, 12, 1),
      ),
    );

    expect(
      (await cacheA.readSummary())?.items.single.pendingPreview,
      'Bash · 运行测试',
    );
    expect((await cacheB.readSummary())?.items, isEmpty);

    await cacheStore.clear(macA.computerKey);
    expect(await cacheA.readSummary(), isNull);
    expect((await cacheB.readSummary())?.computerName, 'Mac mini');
  });

  test('跨电脑汇总按紧急度排序、并发上限受控、冷却生效并支持强制刷新', () async {
    var clock = DateTime.utc(2026, 11, 26, 14, 0, 0);
    final computers = [
      _computer('a', 'MacBook Pro'),
      _computer('b', 'Mac mini'),
      _computer('c', 'Lab Server'),
      _computer('d', 'NAS'),
      _computer('e', 'Studio'),
    ];
    var inFlight = 0;
    var maxInFlight = 0;
    final fetchCounts = <String, int>{};

    final coordinator = MultiComputerCoordinator(
      cacheStore: cacheStore,
      now: () => clock,
      maxConcurrency: 2,
      autoCooldown: const Duration(seconds: 20),
      observeStatus: (_) async => throw const ConnectionFailure('incompatible'),
      fetchSummary: (computer, _) async {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        fetchCounts[computer.computerKey] =
            (fetchCounts[computer.computerKey] ?? 0) + 1;
        await Future<void>.delayed(const Duration(milliseconds: 25));
        inFlight--;
        if (computer.name == 'Mac mini') {
          return _summary(
            idHex: 'b',
            name: 'Mac mini',
            syncedAt: clock,
            items: const [
              MobileSummaryItem(
                threadId: 't-mini-approval',
                projectId: 'p-m',
                projectName: 'backend',
                title: '生产发布确认',
                updatedAt: '2026-11-26T13:59:00Z',
                status: MobileThreadStatus.waitingApproval,
                pendingKind: MobileThreadPendingKind.approval,
                pendingPreview: '执行部署脚本',
                unread: true,
                pinned: false,
              ),
              MobileSummaryItem(
                threadId: 't-mini-unread',
                projectId: 'p-m',
                projectName: 'backend',
                title: '单测跑完',
                updatedAt: '2026-11-26T14:00:00Z',
                status: MobileThreadStatus.completed,
                unread: true,
                pinned: false,
              ),
            ],
            working: 1,
          );
        }
        if (computer.name == 'Lab Server') {
          return _summary(
            idHex: 'c',
            name: 'Lab Server',
            syncedAt: clock,
            items: const [
              MobileSummaryItem(
                threadId: 't-lab-error',
                projectId: 'p-l',
                projectName: 'ml-train',
                title: '训练任务中断',
                updatedAt: '2026-11-26T13:58:00Z',
                status: MobileThreadStatus.failed,
                unread: false,
                pinned: false,
              ),
            ],
          );
        }
        return _summary(
          idHex: 'e',
          name: computer.name,
          syncedAt: clock,
          items: const [],
        );
      },
    );
    addTearDown(coordinator.dispose);

    coordinator.updateComputers(computers, identity: identity);
    // MacBook Pro 作为当前活跃电脑，本地直接从实时侧栏衍生摘要，不走后台短连接
    coordinator.setActiveComputer(
      computerKey: computers[0].computerKey,
      connected: true,
      sidebar: SidebarSnapshot(
        projects: const [MobileProjectSummary(id: 'p-a', name: 'frontend')],
        threads: const [
          MobileThreadSummary(
            id: 't-mac-question',
            projectId: 'p-a',
            title: '请确认视觉方案',
            updatedAt: '2026-11-26T13:55:00Z',
            archived: false,
            pinned: false,
            status: MobileThreadStatus.waitingApproval,
            pendingKind: MobileThreadPendingKind.question,
            unread: false,
          ),
        ],
        syncedAt: clock,
      ),
    );

    await coordinator.refreshAll(force: true);

    expect(maxInFlight, lessThanOrEqualTo(2));
    expect(fetchCounts[computers[0].computerKey], isNull);
    expect(fetchCounts[computers[1].computerKey], 1);
    expect(fetchCounts[computers[2].computerKey], 1);

    // 跨机紧急度计数仅统计「非当前电脑」的 attention + error：Mac mini(1) + Lab(1) = 2
    expect(coordinator.otherComputersUrgentCount, 2);
    expect(coordinator.totalCounts.attention, 2);
    expect(coordinator.totalCounts.error, 1);
    expect(coordinator.totalCounts.unread, 1);
    expect(coordinator.totalCounts.working, 1);

    // 排序：attention 按时间倒序（t-mini-approval 13:59 > t-mac-question 13:55）> error（t-lab-error）> unread（t-mini-unread）
    final all = coordinator.inboxItems();
    expect(all.map((e) => e.item.threadId).toList(), [
      't-mini-approval',
      't-mac-question',
      't-lab-error',
      't-mini-unread',
    ]);
    expect(
      coordinator
          .inboxItems(filter: CrossComputerFilter.attention)
          .map((e) => e.item.threadId)
          .toList(),
      ['t-mini-approval', 't-mac-question'],
    );
    expect(
      coordinator
          .inboxItems(computerKey: computers[1].computerKey)
          .map((e) => e.item.threadId)
          .toList(),
      ['t-mini-approval', 't-mini-unread'],
    );

    // 冷却期内非强制刷新跳过，强制刷新立即生效
    clock = clock.add(const Duration(seconds: 5));
    await coordinator.refreshComputer(computers[1].computerKey, force: false);
    expect(fetchCounts[computers[1].computerKey], 1);
    await coordinator.refreshComputer(computers[1].computerKey, force: true);
    expect(fetchCounts[computers[1].computerKey], 2);
  });

  test('单台非当前电脑收到 device-revoked 时仅标记该电脑，不影响其他电脑与汇总', () async {
    final macA = _computer('a', 'MacBook Pro');
    final macB = _computer('b', 'Mac mini');
    final coordinator = MultiComputerCoordinator(
      cacheStore: cacheStore,
      observeStatus: (_) async => throw const ConnectionFailure('incompatible'),
      fetchSummary: (computer, _) async {
        if (computer.computerKey == macB.computerKey) {
          throw const ConnectionFailure('device-revoked');
        }
        return _summary(
          idHex: 'a',
          name: 'MacBook Pro',
          syncedAt: DateTime.utc(2026, 11, 26, 14, 0),
          items: const [],
        );
      },
    );
    addTearDown(coordinator.dispose);

    coordinator.updateComputers([macA, macB], identity: identity);
    coordinator.setActiveComputer(
      computerKey: macA.computerKey,
      connected: true,
    );

    await coordinator.refreshComputer(macB.computerKey, force: true);

    final entryB = coordinator.entryFor(macB.computerKey)!;
    final entryA = coordinator.entryFor(macA.computerKey)!;
    expect(entryB.isRevoked, isTrue);
    expect(entryB.lastError, 'device-revoked');
    expect(entryA.isRevoked, isFalse);
    expect(entryA.activeConnected, isTrue);
  });
}
