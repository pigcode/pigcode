import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/workbench/git_workbench_tab.dart';
import 'package:pigcode_mobile/workbench/mobile_workbench_screen.dart';
import 'package:pigcode_mobile/workbench/pr_status_tab.dart';

class _GitPrHost implements HostRequests {
  MobilePrStatusResult prStatus = const MobilePrStatusResult(
    status: 'no-pr',
    branch: 'feat/demo',
  );
  List<MobileWorktreeItem> worktrees = const [
    MobileWorktreeItem(
      id: 'wt-1',
      name: 'pigcode-wt-1',
      branch: 'feat/wt-1',
      active: false,
    ),
  ];
  bool mainActive = true;
  List<MobileCheckpointItem> checkpoints = const [
    MobileCheckpointItem(
      id: 'ck-1',
      runId: 'run-1',
      phase: 'final',
      label: null,
      createdAt: '2026-11-26T00:00:00.000Z',
      restorable: true,
    ),
  ];

  final List<({String method, Map<String, Object?> params})> calls = [];

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: Map<String, Object?>.from(params)));
    switch (method) {
      case MobileWorkbenchMethods.list:
        return const MobileDirectoryListing(
          path: '',
          entries: [],
          truncated: false,
        ).toJson();
      case MobileWorkbenchMethods.prStatus:
        return prStatus.toJson();
      case MobileWorkbenchWriteMethods.worktreeList:
        return MobileWorktreeListResult(
          worktrees: worktrees,
          mainActive: mainActive,
        ).toJson();
      case MobileWorkbenchWriteMethods.worktreeCreate:
        const created = MobileWorktreeItem(
          id: 'wt-2',
          name: 'pigcode-wt-2',
          branch: 'feat/wt-2',
          active: true,
        );
        worktrees = [
          for (final w in worktrees)
            MobileWorktreeItem(
              id: w.id,
              name: w.name,
              branch: w.branch,
              active: false,
            ),
          created,
        ];
        mainActive = false;
        return {'worktree': created.toJson()};
      case MobileWorkbenchWriteMethods.worktreeSwitch:
        final id = params['worktreeId'] as String;
        MobileWorktreeItem? picked;
        worktrees = [
          for (final w in worktrees)
            () {
              final next = MobileWorktreeItem(
                id: w.id,
                name: w.name,
                branch: w.branch,
                active: w.id == id,
              );
              if (next.active) picked = next;
              return next;
            }(),
        ];
        mainActive = false;
        return {'worktree': picked!.toJson()};
      case MobileWorkbenchWriteMethods.worktreeRemove:
        worktrees = worktrees.where((w) => !w.active).toList();
        mainActive = true;
        return {'removed': true};
      case MobileWorkbenchWriteMethods.checkpointList:
        return MobileCheckpointListResult(checkpoints: checkpoints).toJson();
      case MobileWorkbenchWriteMethods.checkpointCreate:
        final created = MobileCheckpointItem(
          id: 'ck-manual',
          runId: null,
          phase: 'manual',
          label: params['label'] as String?,
          createdAt: '2026-11-26T01:00:00.000Z',
          restorable: true,
        );
        checkpoints = [...checkpoints, created];
        return {'checkpoint': created.toJson()};
      case MobileWorkbenchWriteMethods.checkpointRestore:
        return MobileCheckpointRestoreResult(
          checkpointId: params['checkpointId'] as String,
          affectedCount: 3,
          affectedPaths: const ['a.dart', 'b.dart', 'c.dart'],
        ).toJson();
      case MobileWorkbenchWriteMethods.prCreate:
        prStatus = MobilePrStatusResult(
          status: 'ok',
          branch: 'feat/demo',
          pr: MobilePullRequestInfo(
            number: 99,
            title: params['title'] as String,
            state: 'OPEN',
            url: 'https://github.com/pigcode/pigcode/pull/99',
            headRefName: 'feat/demo',
            baseRefName: (params['base'] as String?) ?? 'main',
            isDraft: params['draft'] == true,
          ),
        );
        return prStatus.toJson();
      case MobileWorkbenchWriteMethods.prReady:
        prStatus = MobilePrStatusResult(
          status: 'ok',
          branch: 'feat/demo',
          pr: MobilePullRequestInfo(
            number: 99,
            title: prStatus.pr!.title,
            state: 'OPEN',
            url: prStatus.pr!.url,
            headRefName: 'feat/demo',
            baseRefName: 'main',
            isDraft: false,
          ),
        );
        return prStatus.toJson();
      case MobileWorkbenchWriteMethods.prComment:
        return {'ok': true};
      case MobileWorkbenchWriteMethods.prClose:
        prStatus = MobilePrStatusResult(
          status: 'ok',
          branch: 'feat/demo',
          pr: MobilePullRequestInfo(
            number: 99,
            title: prStatus.pr!.title,
            state: 'CLOSED',
            url: prStatus.pr!.url,
            headRefName: 'feat/demo',
            baseRefName: 'main',
            isDraft: false,
          ),
        );
        return prStatus.toJson();
      case MobileWorkbenchWriteMethods.prReopen:
        prStatus = MobilePrStatusResult(
          status: 'ok',
          branch: 'feat/demo',
          pr: MobilePullRequestInfo(
            number: 99,
            title: prStatus.pr!.title,
            state: 'OPEN',
            url: prStatus.pr!.url,
            headRefName: 'feat/demo',
            baseRefName: 'main',
            isDraft: false,
          ),
        );
        return prStatus.toJson();
      case MobileWorkbenchWriteMethods.prMerge:
        prStatus = MobilePrStatusResult(
          status: 'ok',
          branch: 'feat/demo',
          pr: MobilePullRequestInfo(
            number: 99,
            title: prStatus.pr!.title,
            state: 'MERGED',
            url: prStatus.pr!.url,
            headRefName: 'feat/demo',
            baseRefName: 'main',
            isDraft: false,
          ),
        );
        return prStatus.toJson();
      default:
        throw StateError('Unexpected RPC method: $method');
    }
  }
}

class _FakeGitPrConnection implements MobileConnection {
  _FakeGitPrConnection(HostRequests host, {this.supportsWorkbenchWrite = true})
    : workbench = MobileWorkbenchCommands(host, supportsWorkbenchRead: true),
      workbenchWrite = MobileWorkbenchWriteClient(
        host,
        supportsWorkbenchWrite: supportsWorkbenchWrite,
      );

  @override
  final bool supportsWorkbenchWrite;

  @override
  bool get supportsWorkbenchRead => true;

  @override
  final MobileWorkbenchCommands workbench;

  @override
  final MobileWorkbenchWriteClient workbenchWrite;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _app(Widget child) => MaterialApp(
  theme: pigcodeTheme(Brightness.light),
  home: child,
);

void main() {
  testWidgets(
    'shows 4 workbench tabs and completes worktree & ADR 0003 checkpoint workflows in Git tab',
    (tester) async {
      final host = _GitPrHost();
      final conn = _FakeGitPrConnection(host);

      await tester.pumpWidget(
        _app(
          MobileWorkbenchScreen(
            connection: conn,
            threadId: 'th_1',
            previewTabBuilder: (_) => const Center(child: Text('Preview')),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(MobileWorkbenchScreen.filesTabKey), findsOneWidget);
      expect(find.byKey(MobileWorkbenchScreen.gitTabKey), findsOneWidget);
      expect(find.byKey(MobileWorkbenchScreen.prTabKey), findsOneWidget);
      expect(find.byKey(MobileWorkbenchScreen.previewTabKey), findsOneWidget);

      await tester.tap(find.byKey(MobileWorkbenchScreen.gitTabKey));
      await tester.pumpAndSettle();

      // Switch worktree -> then remove active worktree with confirm.
      await tester.tap(find.byKey(GitWorkbenchTab.switchWorktreeKey('wt-1')));
      await tester.pumpAndSettle();
      expect(find.byKey(GitWorkbenchTab.removeWorktreeButtonKey), findsOneWidget);

      await tester.tap(find.byKey(GitWorkbenchTab.removeWorktreeButtonKey));
      await tester.pumpAndSettle();
      expect(find.text('移除当前 Worktree？'), findsOneWidget);
      await tester.tap(find.text('确认移除'));
      await tester.pumpAndSettle();
      expect(find.text('已移除 Worktree 并切回主工作区'), findsOneWidget);

      // Create manual checkpoint with label.
      await tester.tap(find.byKey(GitWorkbenchTab.createCheckpointButtonKey));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, '重构前');
      await tester.tap(find.text('创建'));
      await tester.pumpAndSettle();
      expect(find.text('重构前'), findsOneWidget);

      // Restore checkpoint verifies ADR 0003 copy & reports affected count.
      await tester.tap(find.byKey(GitWorkbenchTab.restoreCheckpointKey('ck-1')));
      await tester.pumpAndSettle();
      expect(find.textContaining('不会回滚对话记录'), findsOneWidget);
      await tester.tap(find.text('确认恢复'));
      await tester.pumpAndSettle();
      expect(find.text('已恢复检查点（影响 3 个文件）'), findsOneWidget);
    },
  );

  testWidgets('disables worktree switch/remove and checkpoint restore when threadBusy', (
    tester,
  ) async {
    final host = _GitPrHost();
    final conn = _FakeGitPrConnection(host);

    await tester.pumpWidget(
      _app(
        Scaffold(
          body: GitWorkbenchTab(
            connection: conn,
            threadId: 'th_1',
            threadBusy: true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('会话运行中'), findsOneWidget);
    final createBtn = tester.widget<TextButton>(
      find.byKey(GitWorkbenchTab.createWorktreeButtonKey),
    );
    expect(createBtn.onPressed, isNull);
    final switchBtn = tester.widget<OutlinedButton>(
      find.byKey(GitWorkbenchTab.switchWorktreeKey('wt-1')),
    );
    expect(switchBtn.onPressed, isNull);
    final restoreBtn = tester.widget<OutlinedButton>(
      find.byKey(GitWorkbenchTab.restoreCheckpointKey('ck-1')),
    );
    expect(restoreBtn.onPressed, isNull);
  });

  testWidgets(
    'supports full PR write lifecycle: create draft -> ready -> comment -> close -> reopen -> merge',
    (tester) async {
      final host = _GitPrHost();
      final conn = _FakeGitPrConnection(host);

      await tester.pumpWidget(
        _app(
          Scaffold(
            body: PrStatusTab(connection: conn, threadId: 'th_1'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Create draft PR.
      await tester.tap(find.byKey(PrStatusTab.createPrButtonKey));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('pr-create-title-input')),
        'Mobile PR write',
      );
      await tester.tap(find.byKey(const ValueKey('pr-create-draft-switch')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('pr-create-submit')));
      await tester.pumpAndSettle();
      expect(find.text('DRAFT'), findsOneWidget);

      // Mark ready.
      await tester.ensureVisible(find.byKey(PrStatusTab.readyPrButtonKey));
      await tester.tap(find.byKey(PrStatusTab.readyPrButtonKey));
      await tester.pumpAndSettle();
      expect(find.text('OPEN'), findsOneWidget);

      // Comment.
      await tester.drag(find.byType(ListView), const Offset(0, -320));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(PrStatusTab.commentInputKey), 'Ship it');
      await tester.pump();
      await tester.tap(find.byKey(PrStatusTab.commentSubmitButtonKey));
      await tester.pumpAndSettle();
      expect(find.text('已发表评论'), findsOneWidget);

      // Close with confirm -> Reopen.
      await tester.ensureVisible(find.byKey(PrStatusTab.closePrButtonKey));
      await tester.tap(find.byKey(PrStatusTab.closePrButtonKey));
      await tester.pumpAndSettle();
      await tester.tap(find.text('确认关闭'));
      await tester.pumpAndSettle();
      expect(find.text('CLOSED'), findsOneWidget);

      await tester.ensureVisible(find.byKey(PrStatusTab.reopenPrButtonKey));
      await tester.tap(find.byKey(PrStatusTab.reopenPrButtonKey));
      await tester.pumpAndSettle();
      expect(find.text('OPEN'), findsOneWidget);

      // Merge with rebase + deleteBranch.
      await tester.ensureVisible(find.byKey(PrStatusTab.mergePrButtonKey));
      await tester.tap(find.byKey(PrStatusTab.mergePrButtonKey));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Rebase 变基合并'));
      await tester.tap(find.byKey(const ValueKey('pr-merge-delete-branch')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('pr-merge-confirm')));
      await tester.pumpAndSettle();
      expect(find.text('MERGED'), findsOneWidget);
      expect(
        host.calls.any(
          (c) =>
              c.method == MobileWorkbenchWriteMethods.prMerge &&
              c.params['method'] == 'rebase' &&
              c.params['deleteBranch'] == true,
        ),
        isTrue,
      );
    },
  );

  testWidgets(
    'MobileWorkbenchScreen switches to new connection after disconnect and reconnect',
    (tester) async {
      final host1 = _GitPrHost();
      final host2 = _GitPrHost();
      final conn1 = _FakeGitPrConnection(host1);
      final conn2 = _FakeGitPrConnection(host2);
      final notifier = ValueNotifier<MobileConnection?>(conn1);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _app(
          MobileWorkbenchScreen(
            connection: conn1,
            connectionListenable: notifier,
            threadId: 'th_1',
            initialTab: MobileWorkbenchTab.git,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Simulate desktop restart / network drop -> offline banner appears.
      notifier.value = null;
      await tester.pump();
      expect(find.byKey(MobileWorkbenchScreen.offlineBannerKey), findsOneWidget);

      // Reconnect with fresh connection -> banner clears and subsequent writes use host2.
      notifier.value = conn2;
      await tester.pumpAndSettle();
      expect(find.byKey(MobileWorkbenchScreen.offlineBannerKey), findsNothing);

      final calls1Before = host1.calls.length;
      await tester.tap(find.byKey(GitWorkbenchTab.createCheckpointButtonKey));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).last, 'after-reconnect');
      await tester.tap(find.text('创建'));
      await tester.pumpAndSettle();

      expect(host1.calls.length, calls1Before);
      expect(
        host2.calls.any(
          (c) =>
              c.method == MobileWorkbenchWriteMethods.checkpointCreate &&
              c.params['label'] == 'after-reconnect',
        ),
        isTrue,
      );
    },
  );
}
