import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/offline_cache.dart';
import 'package:pigcode_mobile/workspace.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

const _computer = '工作电脑';
final _syncedAt = DateTime.utc(2025, 6, 18, 8, 31);

final _sidebar = SidebarSnapshot(
  projects: const [
    MobileProjectSummary(id: 'client', name: '手机端'),
    MobileProjectSummary(id: 'docs', name: '项目文档'),
  ],
  threads: const [
    MobileThreadSummary(
      id: 'review',
      projectId: 'client',
      title: '检查连接提示',
      updatedAt: '2025-06-18T08:30:00Z',
      archived: false,
      pinned: true,
      status: MobileThreadStatus.completed,
      unread: false,
    ),
    MobileThreadSummary(
      id: 'approval',
      projectId: 'client',
      title: '准备模拟器回归',
      updatedAt: '2025-06-18T08:20:00Z',
      archived: false,
      pinned: false,
      status: MobileThreadStatus.waitingApproval,
      unread: true,
    ),
    MobileThreadSummary(
      id: 'test',
      projectId: 'client',
      title: '运行手机端测试',
      updatedAt: '2025-06-18T08:15:00Z',
      archived: false,
      pinned: false,
      status: MobileThreadStatus.running,
      unread: false,
    ),
    MobileThreadSummary(
      id: 'notes',
      projectId: 'docs',
      title: '补充验收步骤',
      updatedAt: '2025-06-18T08:10:00Z',
      archived: false,
      pinned: false,
      status: MobileThreadStatus.completed,
      unread: true,
    ),
  ],
  syncedAt: _syncedAt,
);

TimelineSnapshot _history(MobileTimelinePendingKind? pending, bool running) =>
    TimelineSnapshot(
      events: [
        const MobileTimelineEvent(
          seq: 1,
          runId: 'review',
          kind: MobileTimelineKind.runStarted,
          text: '帮我检查一下手机端的连接提示。',
          createdAt: '2025-06-18T08:30:00Z',
        ),
        const MobileTimelineEvent(
          seq: 2,
          runId: 'review',
          kind: MobileTimelineKind.reasoning,
          text: '对照会话页与离线缓存的状态文案。',
          createdAt: '2025-06-18T08:30:01Z',
        ),
        const MobileTimelineEvent(
          seq: 3,
          runId: 'review',
          kind: MobileTimelineKind.messageAssistant,
          text:
              '已检查连接提示。\n\n'
              '- 连接恢复后会刷新侧栏和时间线。\n'
              '- 离线时会显示上次同步时间，历史仍可查看。\n\n'
              '可在手机工程运行 `flutter test` 复验。',
          createdAt: '2025-06-18T08:30:07Z',
        ),
        const MobileTimelineEvent(
          seq: 4,
          runId: 'review',
          kind: MobileTimelineKind.runCompleted,
          createdAt: '2025-06-18T08:30:08Z',
        ),
        const MobileTimelineEvent(
          seq: 5,
          runId: 'review',
          kind: MobileTimelineKind.changes,
          createdAt: '2025-06-18T08:30:08Z',
        ),
        if (pending != null || running)
          const MobileTimelineEvent(
            seq: 6,
            runId: 'next',
            kind: MobileTimelineKind.runStarted,
            text: '继续跑一遍模拟器回归。',
            createdAt: '2025-06-18T08:30:12Z',
          ),
      ],
      through: pending != null || running ? 6 : 5,
      cursor: pending != null || running ? 6 : 5,
      nextBefore: null,
      live: pending == null && !running
          ? null
          : MobileActiveRun(
              runId: 'next',
              // The visual fixture starts at 0s on every render.
              startedAt: '9999-01-01T00:00:00Z',
              revision: 1,
              text: running ? '我正在核对会话输出和连接状态。' : '',
              textTruncated: false,
              reasoning: '',
              reasoningTruncated: false,
              tools: const [],
              pending: [
                if (pending != null)
                  MobileTimelinePending(id: pending.name, kind: pending),
              ],
              step: '核对会话状态',
              finishedSteps: 2,
              totalSteps: 5,
            ),
    );

Widget workspaceFixture({
  bool online = true,
  bool running = false,
  MobileTimelinePendingKind? pending,
  Future<MobileRunChangesPage>? changedFiles,
}) {
  final history = _history(pending, running);
  final status = pending != null
      ? MobileThreadStatus.waitingApproval
      : running
      ? MobileThreadStatus.running
      : MobileThreadStatus.completed;
  final sidebar = SidebarSnapshot(
    projects: _sidebar.projects,
    threads: [
      MobileThreadSummary.fromJson({
        ..._sidebar.threads.first.toJson(),
        'status': status.wire,
      }),
      ..._sidebar.threads.skip(1),
    ],
    syncedAt: _syncedAt,
  );
  final connection = _FixtureConnection(history, sidebar, changedFiles);
  return MobileWorkspace(
    connection: online ? connection : null,
    connected: online,
    computer: connection.computer,
    deviceId: connection.deviceId,
    cache: online ? null : _FixtureCache(history, sidebar),
    connectionLabel: online ? '已连接' : '电脑离线',
    reconnect: () {},
    onComputers: () {},
    onSettings: () {},
  );
}

const _changedFiles = MobileRunChangesPage(
  diffAvailable: true,
  files: [
    MobileRunChangedFile(path: 'lib/connection.dart', added: 3, removed: 2),
    MobileRunChangedFile(path: 'docs/mobile.md', added: 1, removed: 0),
  ],
);

const _connectionDiff = MobileRunDiffPage(
  text: '''@@ -8,3 +8,4 @@
 String statusLabel(bool connected) {
-  return connected ? 'Online' : 'Unknown';
+  if (connected) return 'Online';
+  return 'Computer offline';
 }
@@ -21,3 +22,3 @@
 void retryConnection() {
-  reconnect();
+  reconnect(delay: const Duration(seconds: 2));
 }''',
);

class _FixtureConnection implements MobileConnection {
  _FixtureConnection(
    this.history,
    this.sidebar,
    Future<MobileRunChangesPage>? changedFiles,
  ) : changes = MobileRunChanges(_FixtureHost(changedFiles: changedFiles));

  final TimelineSnapshot history;
  final SidebarSnapshot sidebar;

  @override
  final computer = ComputerProfile(
    address: 'wss://localhost/ws/v1/connect',
    token: 'fixture',
    computerKey: base64Url.encode(List<int>.filled(32, 1)).replaceAll('=', ''),
    name: _computer,
  );

  @override
  final pendingRequests = MobilePendingRequests(const _FixtureHost());

  @override
  final MobileRunChanges changes;

  @override
  final queue = MobileQueueCommands(const _FixtureHost());

  @override
  final drafts = MobileDraftCommands(const _FixtureHost());

  @override
  final done = Completer<void>().future;

  @override
  String get computerName => _computer;

  @override
  String get deviceId => 'visual-fixture';

  @override
  bool get supportsRequestCommands => true;

  @override
  bool get supportsRunCommands => true;

  @override
  bool get supportsQueueCommands => true;

  @override
  bool get supportsRunChanges => true;

  @override
  bool get supportsSidebar => true;

  @override
  bool get supportsSidebarCommands => false;

  @override
  bool get supportsDraftCommands => true;

  @override
  Future<MobileSidebar> openSidebar() async => _FixtureSidebar(sidebar);

  @override
  Future<MobileTimeline> openTimeline(
    String threadId, {
    TimelineSnapshot? resumeFrom,
  }) async => _FixtureTimeline(history);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FixtureSidebar implements MobileSidebar {
  _FixtureSidebar(this.snapshot);

  @override
  final SidebarSnapshot snapshot;

  @override
  Stream<SidebarSnapshot> get updates => const Stream.empty();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FixtureTimeline implements MobileTimeline {
  _FixtureTimeline(this.snapshot);

  @override
  final TimelineSnapshot snapshot;

  @override
  Stream<TimelineSnapshot> get updates => const Stream.empty();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FixtureCache implements ComputerOfflineCache {
  _FixtureCache(this.history, this.sidebar);

  final TimelineSnapshot history;
  final SidebarSnapshot sidebar;

  @override
  Future<SidebarSnapshot?> readSidebar() async => sidebar;

  @override
  Future<CachedTimeline?> readTimeline(String threadId) async =>
      CachedTimeline(history, _syncedAt);

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FixtureHost implements HostRequests {
  const _FixtureHost({this.changedFiles});

  final Future<MobileRunChangesPage>? changedFiles;

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    if (method == MobileDraftMethods.options) {
      return const MobileDraftOptions(
        instances: [
          MobileDraftInstance(
            instanceId: 'demo-codex',
            label: 'Codex',
            agentName: 'Codex',
            permissionModes: [
              MobileDraftPermission.approvalRequired,
              MobileDraftPermission.autoAcceptEdits,
            ],
            defaultPermissionMode: MobileDraftPermission.approvalRequired,
          ),
        ],
        defaultInstanceId: 'demo-codex',
      ).toJson();
    }
    if (method == MobileDraftMethods.models) {
      return const MobileDraftModels(
        models: [MobileDraftModel(id: 'demo-default', label: '默认模型')],
        defaultModelId: 'demo-default',
      ).toJson();
    }
    if (method == QueueMethods.get) {
      return QueueSnapshot(
        threadId: params['threadId'] as String,
        paused: false,
        messages: const [],
      ).toJson();
    }
    if (method == MobileRunChangesMethods.list ||
        method == MobileRunChangesMethods.diff) {
      if (params['threadId'] != 'review' || params['runId'] != 'review') {
        throw StateError('Expected the review run');
      }
      if (method == MobileRunChangesMethods.list) {
        final request = changedFiles;
        return (request == null ? _changedFiles : await request).toJson();
      }
      return switch (params['path']) {
        'lib/connection.dart' => _connectionDiff.toJson(),
        'docs/mobile.md' => const MobileRunDiffPage(
          text: '@@ -0,0 +1 @@\n+Document the connection states.\n',
        ).toJson(),
        _ => throw StateError('Unexpected diff path'),
      };
    }
    if (method != MobileRequestMethods.details) throw StateError(method);
    final requestId = params['requestId'] as String;
    return MobileRequestDetails(
      requestId: requestId,
      threadId: params['threadId'] as String,
      runId: params['runId'] as String,
      approval: requestId == 'approval'
          ? const MobileApproval(
              toolName: 'Bash',
              title: '允许运行 Flutter 测试？',
              detail: 'flutter test test/workspace_test.dart',
              decisions: [
                MobileApprovalDecision.allowOnce,
                MobileApprovalDecision.deny,
              ],
            )
          : null,
      questions: requestId == 'question'
          ? const [
              MobileQuestion(
                question: '本次回归覆盖哪些平台？',
                options: [
                  MobileQuestionOption(label: 'iOS'),
                  MobileQuestionOption(label: 'Android'),
                ],
                multiSelect: true,
                allowCustomAnswer: true,
              ),
            ]
          : null,
    ).toJson();
  }
}
