import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:test/test.dart';

class _StubHost implements HostRequests {
  final List<({String method, Map<String, Object?> params})> calls = [];
  Map<String, Object? Function(Map<String, Object?>)> handlers = {};

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: Map<String, Object?>.from(params)));
    final handler = handlers[method];
    if (handler == null) {
      throw StateError('No stub handler for $method');
    }
    return handler(params);
  }
}

void main() {
  final computerId = 'a' * 64;
  const computerName = 'Mac Studio';
  const t1 = '2026-11-26T10:00:00.000Z';
  const t2 = '2026-11-26T11:00:00.000Z';
  const t3 = '2026-11-26T12:00:00.000Z';

  test('mobileClientFeatures advertises computer.summary within 32 budget', () {
    expect(mobileClientFeatures, contains('computer.summary'));
    expect(mobileClientFeatures.length, lessThanOrEqualTo(32));
    expect(MobileSummaryMethods.summary, 'mobile.summary');
  });

  test(
    'models round-trip JSON, enforce strict fields, and compute helpers',
    () {
      final counts = const MobileSummaryCounts(
        attention: 2,
        error: 1,
        unread: 3,
        working: 4,
        total: 12,
      );
      expect(counts.actionable, 6);
      expect(counts.urgent, 3);
      expect(
        MobileSummaryCounts.fromJson(
          Map<String, dynamic>.from(counts.toJson()),
        ),
        counts,
      );
      expect(
        () => MobileSummaryCounts.fromJson({...counts.toJson(), 'extra': 1}),
        throwsFormatException,
      );
      expect(
        () =>
            MobileSummaryCounts.fromJson({...counts.toJson(), 'attention': -1}),
        throwsFormatException,
      );

      final approvalItem = const MobileSummaryItem(
        threadId: 'th_1',
        projectId: 'pr_1',
        projectName: 'Pigcode',
        title: '发布前检查',
        updatedAt: t3,
        status: MobileThreadStatus.waitingApproval,
        pendingKind: MobileThreadPendingKind.approval,
        pendingPreview: '运行构建验证',
        unread: true,
        pinned: true,
        agentName: 'Claude',
      );
      expect(approvalItem.isAttention, isTrue);
      expect(approvalItem.isError, isFalse);
      expect(approvalItem.isUnread, isFalse);

      final unreadItem = const MobileSummaryItem(
        threadId: 'th_2',
        projectId: 'pr_1',
        projectName: 'Pigcode',
        title: '日志分析',
        updatedAt: t2,
        status: MobileThreadStatus.completed,
        unread: true,
        pinned: false,
      );
      expect(unreadItem.isAttention, isFalse);
      expect(unreadItem.isError, isFalse);
      expect(unreadItem.isUnread, isTrue);

      final failedItem = const MobileSummaryItem(
        threadId: 'th_3',
        projectId: 'pr_1',
        projectName: 'Pigcode',
        title: '编译失败',
        updatedAt: t1,
        status: MobileThreadStatus.failed,
        unread: true,
        pinned: false,
      );
      expect(failedItem.isError, isTrue);
      expect(failedItem.isUnread, isFalse);

      final summary = MobileComputerSummary(
        computerId: computerId,
        computerName: computerName,
        syncedAt: DateTime.parse(t3),
        counts: counts,
        items: [approvalItem, failedItem, unreadItem],
        truncated: false,
      );
      final encoded = summary.toJson();
      final decoded = MobileComputerSummary.fromJson(
        Map<String, dynamic>.from(encoded),
      );
      expect(decoded, summary);
      expect(decoded.hashCode, summary.hashCode);
      expect(decoded.toJson(), encoded);

      expect(
        () => MobileComputerSummary.fromJson({
          ...encoded,
          'computerId': 'invalid',
        }),
        throwsFormatException,
      );
      expect(
        () => MobileComputerSummary.fromJson({...encoded, 'unknown': true}),
        throwsFormatException,
      );
      expect(
        () => MobileSummaryItem.fromJson({
          ...approvalItem.toJson(),
          'pendingPreview': 'x' * (mobileSummaryPreviewLimit + 1),
        }),
        throwsFormatException,
      );
      expect(
        () => MobileComputerSummary.fromJson({
          ...encoded,
          'items': List.generate(
            mobileSummaryMaxItems + 1,
            (i) => {...unreadItem.toJson(), 'threadId': 'th_$i'},
          ),
        }),
        throwsFormatException,
      );
    },
  );

  test(
    'summarizeSidebarSnapshot matches mutually-exclusive counts, ordering, and truncation',
    () {
      final snapshot = SidebarSnapshot(
        projects: const [MobileProjectSummary(id: 'pr_1', name: '核心仓库')],
        threads: const [
          // 归档会话不计入 total 也不进入 items
          MobileThreadSummary(
            id: 'th_archived',
            projectId: 'pr_1',
            title: '已归档审批',
            updatedAt: t3,
            archived: true,
            pinned: false,
            status: MobileThreadStatus.waitingApproval,
            unread: true,
            pendingKind: MobileThreadPendingKind.approval,
          ),
          // 已移除项目的孤儿会话不计入
          MobileThreadSummary(
            id: 'th_orphan',
            projectId: 'pr_deleted',
            title: '旧项目会话',
            updatedAt: t3,
            archived: false,
            pinned: false,
            status: MobileThreadStatus.failed,
            unread: true,
          ),
          // 运行中（即使 unread 为 true 也归入 working）
          MobileThreadSummary(
            id: 'th_running',
            projectId: 'pr_1',
            title: '后台构建',
            updatedAt: t3,
            archived: false,
            pinned: false,
            status: MobileThreadStatus.running,
            unread: true,
          ),
          // 已完成且已读（只计入 total）
          MobileThreadSummary(
            id: 'th_done',
            projectId: 'pr_1',
            title: '已完成任务',
            updatedAt: t3,
            archived: false,
            pinned: false,
            status: MobileThreadStatus.completed,
            unread: false,
          ),
          // 未读（较新）
          MobileThreadSummary(
            id: 'th_unread_b',
            projectId: 'pr_1',
            title: '未读 B',
            updatedAt: t2,
            archived: false,
            pinned: false,
            status: MobileThreadStatus.completed,
            unread: true,
          ),
          // 未读（同时间，threadId 字典序靠前）
          MobileThreadSummary(
            id: 'th_unread_a',
            projectId: 'pr_1',
            title: '未读 A',
            updatedAt: t2,
            archived: false,
            pinned: false,
            status: MobileThreadStatus.idle,
            unread: true,
          ),
          // 出错（同时 unread=true，仅计入 error）
          MobileThreadSummary(
            id: 'th_failed',
            projectId: 'pr_1',
            title: '单测报错',
            updatedAt: t1,
            archived: false,
            pinned: false,
            status: MobileThreadStatus.failed,
            unread: true,
          ),
          // 等待处理（较旧）
          MobileThreadSummary(
            id: 'th_attn_old',
            projectId: 'pr_1',
            title: '等待提问回答',
            updatedAt: t1,
            archived: false,
            pinned: false,
            status: MobileThreadStatus.waitingApproval,
            unread: false,
            pendingKind: MobileThreadPendingKind.question,
            agentName: 'Codex',
          ),
          // 等待处理（较新）
          MobileThreadSummary(
            id: 'th_attn_new',
            projectId: 'pr_1',
            title: '等待执行审批',
            updatedAt: t2,
            archived: false,
            pinned: true,
            status: MobileThreadStatus.waitingApproval,
            unread: true,
            pendingKind: MobileThreadPendingKind.approval,
            agentName: 'Claude',
          ),
        ],
        syncedAt: DateTime.parse(t3),
      );

      final full = summarizeSidebarSnapshot(
        computerId: computerId,
        computerName: computerName,
        snapshot: snapshot,
      );
      expect(
        full.counts,
        const MobileSummaryCounts(
          attention: 2,
          error: 1,
          unread: 2,
          working: 1,
          total: 7,
        ),
      );
      expect(full.truncated, isFalse);
      expect(full.items.map((item) => item.threadId).toList(), [
        'th_attn_new',
        'th_attn_old',
        'th_failed',
        'th_unread_a',
        'th_unread_b',
      ]);
      expect(full.items.first.projectName, '核心仓库');
      expect(full.items.first.pendingKind, MobileThreadPendingKind.approval);
      expect(full.items.first.agentName, 'Claude');
      expect(full.items.first.pinned, isTrue);

      final capped = summarizeSidebarSnapshot(
        computerId: computerId,
        computerName: computerName,
        snapshot: snapshot,
        maxItems: 2,
      );
      expect(capped.truncated, isTrue);
      expect(capped.counts, full.counts);
      expect(capped.items.map((item) => item.threadId).toList(), [
        'th_attn_new',
        'th_attn_old',
      ]);
    },
  );

  test(
    'MobileSummaryClient.fetch uses mobile.summary when supported',
    () async {
      final host = _StubHost();
      host.handlers[MobileSummaryMethods.summary] = (params) {
        expect(params, isEmpty);
        return {
          'computerId': computerId,
          'computerName': computerName,
          'syncedAt': t3,
          'counts': {
            'attention': 1,
            'error': 0,
            'unread': 0,
            'working': 1,
            'total': 3,
          },
          'items': [
            {
              'threadId': 'th_1',
              'projectId': 'pr_1',
              'projectName': 'Pigcode',
              'title': '计划确认',
              'updatedAt': t3,
              'status': 'waiting-approval',
              'pendingKind': 'approval',
              'pendingPreview': '计划审批',
              'unread': false,
              'pinned': false,
              'agentName': 'Claude',
            },
          ],
          'truncated': false,
        };
      };

      final client = MobileSummaryClient(
        host,
        supportsComputerSummary: true,
        computerId: computerId,
        computerName: computerName,
      );
      final summary = await client.fetch();
      expect(host.calls.map((c) => c.method).toList(), [
        MobileSummaryMethods.summary,
      ]);
      expect(summary.counts.attention, 1);
      expect(summary.items.single.pendingPreview, '计划审批');
    },
  );

  test(
    'MobileSummaryClient.fetch falls back to paged sidebar RPCs for legacy desktop',
    () async {
      final host = _StubHost();
      final projectPages = [
        [
          {'id': 'pr_1', 'name': '后端服务'},
        ],
        <Map<String, Object?>>[],
      ];
      final threadPages = [
        [
          {
            'id': 'th_1',
            'projectId': 'pr_1',
            'title': '审批任务',
            'updatedAt': t2,
            'archived': false,
            'pinned': true,
            'status': 'waiting-approval',
            'unread': false,
            'pendingKind': 'approval',
          },
        ],
        [
          {
            'id': 'th_2',
            'projectId': 'pr_1',
            'title': '未读汇报',
            'updatedAt': t3,
            'archived': false,
            'pinned': false,
            'status': 'completed',
            'unread': true,
          },
        ],
        <Map<String, Object?>>[],
      ];

      var projectCalls = 0;
      var threadCalls = 0;
      host.handlers[MobileSidebarMethods.projectList] = (params) {
        final expectedOffset = projectCalls == 0 ? 0 : 1;
        expect(params['offset'], expectedOffset);
        expect(params['limit'], mobileSidebarPageSize);
        return projectPages[projectCalls++];
      };
      host.handlers[MobileSidebarMethods.threadList] = (params) {
        final expectedOffset = threadCalls;
        expect(params['offset'], expectedOffset);
        expect(params['limit'], mobileSidebarPageSize);
        return threadPages[threadCalls++];
      };

      final client = MobileSummaryClient(
        host,
        supportsComputerSummary: false,
        computerId: computerId,
        computerName: computerName,
      );
      final summary = await client.fetch();

      expect(host.calls.map((c) => c.method).toList(), [
        MobileSidebarMethods.projectList,
        MobileSidebarMethods.projectList,
        MobileSidebarMethods.threadList,
        MobileSidebarMethods.threadList,
        MobileSidebarMethods.threadList,
      ]);
      expect(summary.computerId, computerId);
      expect(summary.computerName, computerName);
      expect(
        summary.counts,
        const MobileSummaryCounts(
          attention: 1,
          error: 0,
          unread: 1,
          working: 0,
          total: 2,
        ),
      );
      expect(summary.items.map((item) => item.threadId).toList(), [
        'th_1',
        'th_2',
      ]);
      expect(summary.items.first.projectName, '后端服务');
      expect(summary.items.first.pendingPreview, isNull);
      expect(summary.truncated, isFalse);
    },
  );
}
