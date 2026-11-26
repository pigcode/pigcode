import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/manage/manage_utils.dart';
import 'package:pigcode_mobile/manage/schedule_editor_screen.dart';
import 'package:pigcode_mobile/manage/schedule_manage_screen.dart';
import 'package:pigcode_mobile/manage/schedule_runs_sheet.dart';

class _ScheduleManageHost implements HostRequests {
  _ScheduleManageHost({
    List<Map<String, dynamic>>? schedules,
    List<MobileManagedProject>? projects,
    Map<String, List<Map<String, dynamic>>>? runsBySchedule,
  }) : schedules = schedules ?? _defaultSchedules(),
       projects =
           projects ??
           const [
             MobileManagedProject(
               id: 'pr_1',
               name: 'Pigcode',
               displayPath: '~/workspace/pigcode',
               createdAt: '2026-11-01T00:00:00.000Z',
               threadCount: 4,
             ),
             MobileManagedProject(
               id: 'pr_2',
               name: 'Backend',
               displayPath: '~/workspace/backend',
               createdAt: '2026-11-02T00:00:00.000Z',
               threadCount: 2,
             ),
           ],
       runsBySchedule = runsBySchedule ?? {};

  final List<({String method, Map<String, Object?> params})> calls = [];
  List<Map<String, dynamic>> schedules;
  List<MobileManagedProject> projects;
  Map<String, List<Map<String, dynamic>>> runsBySchedule;
  MobileScheduleRunNowStatus nextRunNowStatus =
      MobileScheduleRunNowStatus.started;
  int _nextCreatedIndex = 100;

  static List<Map<String, dynamic>> _defaultSchedules() => [
    {
      'id': 'sch_1',
      'target': {
        'kind': 'project',
        'projectId': 'pr_1',
        'execution': {
          'instanceId': 'claude-work',
          'modelId': 'claude-sonnet-4-6',
          'effort': 'high',
          'permissionMode': 'full-access',
        },
      },
      'projectName': 'Pigcode',
      'threadTitle': null,
      'title': '晨会总结',
      'prompt': '总结最近 24 小时的代码改动',
      'rule': {'kind': 'weekdays', 'time': '09:00'},
      'endsAt': null,
      'enabled': true,
      'status': 'active',
      'nextRunAt': '2026-11-27T01:00:00.000Z',
      'lastRunAt': '2026-11-26T01:00:00.000Z',
      'lastRunId': 'run_0',
      'runCount': 3,
      'createdAt': '2026-11-20T00:00:00.000Z',
      'updatedAt': '2026-11-26T01:00:00.000Z',
    },
    {
      'id': 'sch_2',
      'target': {'kind': 'thread', 'threadId': 'th_legacy'},
      'projectName': 'Pigcode',
      'threadTitle': '重构中继服务',
      'title': '',
      'prompt': '检查中继心跳日志有没有异常断连',
      'rule': {'kind': 'daily', 'time': '20:00'},
      'endsAt': null,
      'enabled': false,
      'status': 'paused',
      'nextRunAt': null,
      'lastRunAt': '2026-11-25T12:00:00.000Z',
      'lastRunId': 'run_legacy',
      'runCount': 1,
      'createdAt': '2026-11-18T00:00:00.000Z',
      'updatedAt': '2026-11-25T12:00:00.000Z',
    },
    {
      'id': 'sch_3',
      'target': {
        'kind': 'project',
        'projectId': 'pr_2',
        'execution': {'permissionMode': 'full-access'},
      },
      'projectName': 'Backend',
      'threadTitle': null,
      'title': '月报归档',
      'prompt': '汇总本月接口变更记录',
      'rule': {'kind': 'monthly', 'day': 1, 'time': '10:00'},
      'endsAt': '2026-11-01T15:59:59.999Z',
      'enabled': false,
      'status': 'completed',
      'nextRunAt': null,
      'lastRunAt': '2026-11-01T02:00:00.000Z',
      'lastRunId': 'run_done',
      'runCount': 5,
      'createdAt': '2026-06-01T00:00:00.000Z',
      'updatedAt': '2026-11-01T02:00:00.000Z',
    },
  ];

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: Map<String, Object?>.from(params)));
    switch (method) {
      case MobileProjectMethods.list:
        return {'projects': projects.map((p) => p.toJson()).toList()};
      case MobileAgentMethods.list:
        return {
          'defaultAgentId': 'claude',
          'defaultInstanceId': null,
          'agents': [
            {
              'agentId': 'claude',
              'displayName': 'Claude Code',
              'builtin': true,
              'enabled': true,
              'registered': true,
              'requiresInstance': false,
              'acpRegistry': false,
              'secretReferences': false,
              'customModels': true,
              'fields': const <Object>[],
              'instances': [
                {
                  'instanceId': 'claude',
                  'agentId': 'claude',
                  'label': 'Claude Code',
                  'enabled': true,
                  'isDefault': true,
                  'values': const <String, dynamic>{},
                },
                {
                  'instanceId': 'claude-work',
                  'agentId': 'claude',
                  'label': '公司号',
                  'enabled': true,
                  'isDefault': false,
                  'values': const <String, dynamic>{},
                },
              ],
            },
          ],
        };
      case MobileAgentMethods.models:
        return {
          'models': [
            {
              'id': 'claude-sonnet-4-6',
              'name': 'Claude Sonnet 4.6',
              'isCustom': false,
              'hidden': false,
            },
            {
              'id': 'claude-opus-4-6',
              'name': 'Claude Opus 4.6',
              'isCustom': false,
              'hidden': false,
            },
          ],
        };
      case MobileScheduleMethods.list:
        return {'schedules': schedules, 'truncated': false};
      case MobileScheduleMethods.create:
        final projectId = params['projectId'] as String;
        final projectName = projects
            .where((p) => p.id == projectId)
            .map((p) => p.name)
            .firstOrNull;
        final id = 'sch_${_nextCreatedIndex++}';
        final created = <String, dynamic>{
          'id': id,
          'target': {
            'kind': 'project',
            'projectId': projectId,
            'execution':
                (params['execution'] as Map<String, Object?>?) ??
                {'permissionMode': defaultMobileSchedulePermissionMode},
          },
          'projectName': projectName,
          'threadTitle': null,
          'title': (params['title'] as String?) ?? '',
          'prompt': params['prompt'] as String,
          'rule': params['rule'] as Map<String, Object?>,
          'endsAt': params['endsAt'] as String?,
          'enabled': (params['enabled'] as bool?) ?? true,
          'status': ((params['enabled'] as bool?) ?? true)
              ? 'active'
              : 'paused',
          'nextRunAt': '2026-11-27T01:00:00.000Z',
          'lastRunAt': null,
          'lastRunId': null,
          'runCount': 0,
          'createdAt': '2026-11-26T13:00:00.000Z',
          'updatedAt': '2026-11-26T13:00:00.000Z',
        };
        schedules = [created, ...schedules];
        return created;
      case MobileScheduleMethods.update:
        final id = params['id'] as String;
        final idx = schedules.indexWhere((s) => s['id'] == id);
        if (idx < 0) {
          throw const MobileRpcFailure(
            MobileRpcProblem(
              code: 'SCHEDULE_NOT_FOUND',
              message: 'Not found',
              retryable: false,
            ),
          );
        }
        final cur = Map<String, dynamic>.from(schedules[idx]);
        if (params.containsKey('title')) cur['title'] = params['title'];
        if (params.containsKey('prompt')) cur['prompt'] = params['prompt'];
        if (params.containsKey('rule')) cur['rule'] = params['rule'];
        if (params.containsKey('endsAt')) cur['endsAt'] = params['endsAt'];
        if (params.containsKey('enabled')) {
          final enabled = params['enabled'] as bool;
          cur['enabled'] = enabled;
          if (cur['status'] != 'completed') {
            cur['status'] = enabled ? 'active' : 'paused';
          }
        }
        if (params.containsKey('execution')) {
          final target = Map<String, dynamic>.from(
            cur['target'] as Map<String, dynamic>,
          );
          if (target['kind'] == 'thread') {
            throw const MobileRpcFailure(
              MobileRpcProblem(
                code: 'SCHEDULE_LEGACY_LOCKED',
                message: 'Legacy locked',
                retryable: false,
              ),
            );
          }
          target['execution'] = params['execution'];
          cur['target'] = target;
        }
        cur['updatedAt'] = '2026-11-26T14:00:00.000Z';
        schedules = [
          for (var i = 0; i < schedules.length; i++)
            i == idx ? cur : schedules[i],
        ];
        return cur;
      case MobileScheduleMethods.delete:
        final id = params['id'] as String;
        final before = schedules.length;
        schedules = schedules.where((s) => s['id'] != id).toList();
        return {'deleted': schedules.length < before};
      case MobileScheduleMethods.runNow:
        final status = nextRunNowStatus;
        return {
          'status': status.wireValue,
          'runId': status == MobileScheduleRunNowStatus.started
              ? 'run_manual_1'
              : null,
        };
      case MobileScheduleMethods.runs:
        final id = params['id'] as String;
        final limit = (params['limit'] as int?) ?? 20;
        final offset = (params['offset'] as int?) ?? 0;
        final all = runsBySchedule[id] ?? const <Map<String, dynamic>>[];
        final slice = all.skip(offset).take(limit).toList();
        return {'runs': slice, 'total': all.length};
      case MobileScheduleMethods.deleteRun:
        final runId = params['id'] as String;
        var deleted = false;
        for (final entry in runsBySchedule.entries) {
          final next = entry.value.where((r) => r['id'] != runId).toList();
          if (next.length < entry.value.length) {
            runsBySchedule[entry.key] = next;
            deleted = true;
          }
        }
        return {'deleted': deleted};
      default:
        throw StateError('Unexpected method: $method');
    }
  }
}

class _FakeScheduleConnection implements MobileConnection {
  _FakeScheduleConnection(
    HostRequests host, {
    this.supportsProjectManage = true,
    this.supportsAgentManage = true,
    this.supportsScheduleManage = true,
  }) : projects = MobileProjectManageClient(
         host,
         supportsProjectManage: supportsProjectManage,
       ),
       agents = MobileAgentManageClient(
         host,
         supportsAgentManage: supportsAgentManage,
       ),
       schedules = MobileScheduleManageClient(
         host,
         supportsScheduleManage: supportsScheduleManage,
       );

  @override
  String get computerName => 'StudioMac';
  @override
  final bool supportsProjectManage;
  @override
  final bool supportsAgentManage;
  @override
  final bool supportsScheduleManage;
  @override
  bool get supportsSidebar => false;
  @override
  final MobileProjectManageClient projects;
  @override
  final MobileAgentManageClient agents;
  @override
  final MobileScheduleManageClient schedules;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _wrap(Widget home, {Brightness brightness = Brightness.light}) =>
    MaterialApp(theme: pigcodeTheme(brightness), home: home);

Future<void> _reveal(
  WidgetTester tester,
  Finder target,
  Finder scrollable, {
  double delta = 240,
}) async {
  await tester.scrollUntilVisible(target, delta, scrollable: scrollable);
  await tester.ensureVisible(target);
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'ScheduleManageScreen loads list, filters by status, toggles enabled, and reports runNow statuses',
    (tester) async {
      final host = _ScheduleManageHost();
      final conn = _FakeScheduleConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _wrap(ScheduleManageScreen(connectionListenable: notifier)),
      );
      await tester.pumpAndSettle();

      // Cards render title, untitled fallback, project/thread badges, rule summary, and run counts.
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_1')), findsOneWidget);
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_2')), findsOneWidget);
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_3')), findsOneWidget);
      expect(find.text('晨会总结'), findsOneWidget);
      expect(find.text('没有名字的任务'), findsOneWidget);
      expect(find.text('Pigcode'), findsOneWidget);
      expect(find.text('重构中继服务'), findsOneWidget);
      expect(find.text('工作日 09:00'), findsOneWidget);
      expect(find.text('跑了 3 次'), findsOneWidget);

      // Filter: active -> paused -> completed -> all.
      await tester.tap(find.byKey(ScheduleManageScreen.filterActiveKey));
      await tester.pumpAndSettle();
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_1')), findsOneWidget);
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_2')), findsNothing);
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_3')), findsNothing);

      await tester.tap(find.byKey(ScheduleManageScreen.filterPausedKey));
      await tester.pumpAndSettle();
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_1')), findsNothing);
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_2')), findsOneWidget);

      await tester.tap(find.byKey(ScheduleManageScreen.filterCompletedKey));
      await tester.pumpAndSettle();
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_3')), findsOneWidget);
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_2')), findsNothing);

      await tester.tap(find.byKey(ScheduleManageScreen.filterAllKey));
      await tester.pumpAndSettle();
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_1')), findsOneWidget);
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_2')), findsOneWidget);
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_3')), findsOneWidget);

      // Toggle switch on sch_1.
      await tester.tap(find.byKey(ScheduleManageScreen.toggleKey('sch_1')));
      await tester.pumpAndSettle();
      final updateCall = host.calls.lastWhere(
        (c) => c.method == MobileScheduleMethods.update,
      );
      expect(updateCall.params['id'], 'sch_1');
      expect(updateCall.params['enabled'], isFalse);

      // Test all 4 runNow statuses show proper SnackBar feedback.
      for (final (status, expectedText) in const [
        (MobileScheduleRunNowStatus.started, '任务开始了'),
        (MobileScheduleRunNowStatus.busy, '上一次还没跑完，等会再试'),
        (MobileScheduleRunNowStatus.unavailable, 'Agent 用不了，任务没开始'),
        (MobileScheduleRunNowStatus.failed, '任务没开始，去运行记录里看看'),
      ]) {
        host.nextRunNowStatus = status;
        await tester.tap(find.byKey(ScheduleManageScreen.runNowKey('sch_1')));
        await tester.pumpAndSettle();
        expect(find.text(expectedText), findsOneWidget);
        ScaffoldMessenger.of(
          tester.element(find.byType(ScheduleManageScreen)),
        ).clearSnackBars();
        await tester.pumpAndSettle();
      }
    },
  );

  testWidgets(
    'Empty state quick templates prefill ScheduleEditorScreen and submit create params',
    (tester) async {
      final host = _ScheduleManageHost(schedules: []);
      final conn = _FakeScheduleConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _wrap(ScheduleManageScreen(connectionListenable: notifier)),
      );
      await tester.pumpAndSettle();

      // Empty state + 4 desktop templates visible.
      expect(find.text('还没有定时任务'), findsOneWidget);
      expect(find.text('每日总结'), findsOneWidget);
      expect(find.text('找问题'), findsOneWidget);
      expect(find.text('更新说明'), findsOneWidget);
      expect(find.text('查过时文档'), findsOneWidget);

      // Tap "每日总结" template to open editor.
      await tester.tap(find.byKey(ScheduleManageScreen.templateKey('standup')));
      await tester.pumpAndSettle();

      expect(find.text('新建任务'), findsOneWidget);
      final titleField = tester.widget<TextField>(
        find.byKey(ScheduleEditorScreen.titleInputKey),
      );
      final promptField = tester.widget<TextField>(
        find.byKey(ScheduleEditorScreen.promptInputKey),
      );
      expect(titleField.controller?.text, '每日总结');
      expect(promptField.controller?.text, contains('晨会总结'));
      expect(find.text('工作日 09:00'), findsOneWidget);

      // Scroll to execution settings and pick agent instance, model, permission, worktree.
      Finder editorScrollable() => find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first;

      await _reveal(
        tester,
        find.byKey(ScheduleEditorScreen.execAgentKey),
        editorScrollable(),
      );
      await tester.tap(find.byKey(ScheduleEditorScreen.execAgentKey));
      await tester.pumpAndSettle();
      await tester.tap(find.text('公司号 (Claude Code)').last);
      await tester.pumpAndSettle();

      await _reveal(
        tester,
        find.byKey(ScheduleEditorScreen.execModelKey),
        editorScrollable(),
      );
      await tester.tap(find.byKey(ScheduleEditorScreen.execModelKey));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Claude Sonnet 4.6').last);
      await tester.pumpAndSettle();

      await _reveal(
        tester,
        find.byKey(ScheduleEditorScreen.execPermissionKey),
        editorScrollable(),
      );
      await tester.tap(find.byKey(ScheduleEditorScreen.execPermissionKey));
      await tester.pumpAndSettle();
      await tester.tap(find.text('接受编辑').last);
      await tester.pumpAndSettle();

      await _reveal(
        tester,
        find.byKey(ScheduleEditorScreen.execWorktreeKey),
        editorScrollable(),
      );
      await tester.tap(find.byKey(ScheduleEditorScreen.execWorktreeKey));
      await tester.pumpAndSettle();

      // Save create.
      await tester.tap(find.byKey(ScheduleEditorScreen.saveButtonKey));
      await tester.pumpAndSettle();

      final createCall = host.calls.singleWhere(
        (c) => c.method == MobileScheduleMethods.create,
      );
      expect(createCall.params['projectId'], 'pr_1');
      expect(createCall.params['title'], '每日总结');
      expect(createCall.params['prompt'], contains('晨会总结'));
      expect(createCall.params['rule'], {'kind': 'weekdays', 'time': '09:00'});
      expect(createCall.params['enabled'], isTrue);
      final exec = createCall.params['execution']! as Map<String, Object?>;
      expect(exec['instanceId'], 'claude-work');
      expect(exec['modelId'], 'claude-sonnet-4-6');
      expect(exec['permissionMode'], 'auto-accept-edits');
      expect(exec['worktree'], isA<Map<String, Object?>>());

      // Returned to list screen with new task rendered.
      expect(find.text('定时任务'), findsOneWidget);
      expect(find.text('每日总结'), findsOneWidget);
    },
  );

  testWidgets(
    'ScheduleEditorScreen edits title & rule without overwriting untouched prompt, supports custom rules & legacy tasks, and confirms delete',
    (tester) async {
      final customSchedule = <String, dynamic>{
        'id': 'sch_custom',
        'target': {
          'kind': 'project',
          'projectId': 'pr_1',
          'execution': {'permissionMode': 'full-access'},
        },
        'projectName': 'Pigcode',
        'threadTitle': null,
        'title': '双月巡检',
        'prompt': '检查所有依赖版本与安全公告',
        'rule': {
          'kind': 'everyMonths',
          'every': 2,
          'days': [1, 15],
          'time': '14:30',
          'anchor': '2026-01-01T00:00:00.000Z',
        },
        'endsAt': null,
        'enabled': true,
        'status': 'active',
        'nextRunAt': '2026-12-01T06:30:00.000Z',
        'lastRunAt': null,
        'lastRunId': null,
        'runCount': 0,
        'createdAt': '2026-11-20T00:00:00.000Z',
        'updatedAt': '2026-11-20T00:00:00.000Z',
      };
      final host = _ScheduleManageHost(
        schedules: [..._ScheduleManageHost._defaultSchedules(), customSchedule],
      );
      final conn = _FakeScheduleConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _wrap(ScheduleManageScreen(connectionListenable: notifier)),
      );
      await tester.pumpAndSettle();

      // 1. Edit sch_1: change title & switch frequency to hourly, leave prompt untouched.
      await tester.tap(find.text('晨会总结'));
      await tester.pumpAndSettle();
      expect(find.text('编辑任务'), findsOneWidget);

      await tester.enterText(
        find.byKey(ScheduleEditorScreen.titleInputKey),
        '每小时巡检',
      );

      Finder editorScrollable() => find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first;

      await _reveal(
        tester,
        find.byKey(ScheduleEditorScreen.frequencyKey('hourly')),
        editorScrollable(),
      );
      await tester.tap(find.byKey(ScheduleEditorScreen.frequencyKey('hourly')));
      await tester.pumpAndSettle();
      expect(find.text('每小时第 0 分'), findsOneWidget);

      await tester.tap(find.byKey(ScheduleEditorScreen.saveButtonKey));
      await tester.pumpAndSettle();

      final editCall = host.calls.lastWhere(
        (c) =>
            c.method == MobileScheduleMethods.update &&
            c.params['id'] == 'sch_1',
      );
      expect(editCall.params['title'], '每小时巡检');
      expect(editCall.params['rule'], {'kind': 'hourly', 'minute': 0});
      // Untouched prompt must NOT be sent.
      expect(editCall.params.containsKey('prompt'), isFalse);

      // 2. Open custom everyMonths schedule, verify rule preserved and change every -> 3.
      Finder listScrollable() => find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first;

      await _reveal(
        tester,
        find.byKey(ScheduleManageScreen.cardKey('sch_custom')),
        listScrollable(),
      );
      await tester.tap(find.text('双月巡检'));
      await tester.pumpAndSettle();

      await _reveal(
        tester,
        find.byKey(ScheduleEditorScreen.customEveryKey),
        editorScrollable(),
      );
      expect(find.text('每 2 个月 1、15 日 14:30'), findsOneWidget);
      await tester.enterText(
        find.byKey(ScheduleEditorScreen.customEveryKey),
        '3',
      );
      await tester.pumpAndSettle();
      expect(find.text('每 3 个月 1、15 日 14:30'), findsOneWidget);

      await tester.tap(find.byKey(ScheduleEditorScreen.saveButtonKey));
      await tester.pumpAndSettle();
      final customUpdate = host.calls.lastWhere(
        (c) =>
            c.method == MobileScheduleMethods.update &&
            c.params['id'] == 'sch_custom',
      );
      expect(customUpdate.params['rule'], {
        'kind': 'everyMonths',
        'every': 3,
        'days': [1, 15],
        'time': '14:30',
        'anchor': '2026-01-01T00:00:00.000Z',
      });
      expect(customUpdate.params.containsKey('prompt'), isFalse);

      // 3. Legacy thread schedule shows notice and never sends execution.
      await _reveal(
        tester,
        find.text('没有名字的任务'),
        listScrollable(),
        delta: -240,
      );
      await tester.tap(find.text('没有名字的任务'));
      await tester.pumpAndSettle();
      await _reveal(
        tester,
        find.text('旧版会话绑定的定时任务沿用原会话配置'),
        editorScrollable(),
      );
      expect(find.text('旧版会话绑定的定时任务沿用原会话配置'), findsOneWidget);

      // 4. Delete with double confirmation.
      await _reveal(
        tester,
        find.byKey(ScheduleEditorScreen.deleteButtonKey),
        editorScrollable(),
      );
      await tester.tap(find.byKey(ScheduleEditorScreen.deleteButtonKey));
      await tester.pumpAndSettle();
      expect(find.text('删除这个任务？'), findsOneWidget);
      expect(find.text('任务和运行记录会删掉，已有的会话还在'), findsOneWidget);

      await tester.tap(find.byKey(ScheduleEditorScreen.deleteConfirmKey));
      await tester.pumpAndSettle();
      expect(
        host.calls.any(
          (c) =>
              c.method == MobileScheduleMethods.delete &&
              c.params['id'] == 'sch_2',
        ),
        isTrue,
      );
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_2')), findsNothing);
    },
  );

  testWidgets(
    'ScheduleRunsSheet loads paginated runs, deletes a run, and navigates via onOpenThread',
    (tester) async {
      final runs = <Map<String, dynamic>>[
        {
          'id': 'run_0',
          'scheduleId': 'sch_1',
          'source': 'schedule',
          'status': 'succeeded',
          'threadId': 'th_open_me',
          'runId': 'r_0',
          'error': null,
          'triggeredAt': '2026-11-26T09:00:00.000Z',
          'finishedAt': '2026-11-26T09:01:30.000Z',
        },
        {
          'id': 'run_1',
          'scheduleId': 'sch_1',
          'source': 'schedule',
          'status': 'skipped',
          'threadId': null,
          'runId': null,
          'error': 'THREAD_BUSY',
          'triggeredAt': '2026-11-26T08:00:00.000Z',
          'finishedAt': '2026-11-26T08:00:01.000Z',
        },
        {
          'id': 'run_2',
          'scheduleId': 'sch_1',
          'source': 'manual',
          'status': 'failed',
          'threadId': null,
          'runId': null,
          'error': 'AGENT_UNAVAILABLE',
          'triggeredAt': '2026-11-26T07:00:00.000Z',
          'finishedAt': '2026-11-26T07:00:02.000Z',
        },
        {
          'id': 'run_3',
          'scheduleId': 'sch_1',
          'source': 'manual',
          'status': 'running',
          'threadId': 'th_running',
          'runId': 'r_3',
          'error': null,
          'triggeredAt': '2026-11-26T06:00:00.000Z',
          'finishedAt': null,
        },
        {
          'id': 'run_4',
          'scheduleId': 'sch_1',
          'source': 'schedule',
          'status': 'stopped',
          'threadId': null,
          'runId': 'r_4',
          'error': null,
          'triggeredAt': '2026-11-26T05:00:00.000Z',
          'finishedAt': '2026-11-26T05:00:20.000Z',
        },
        for (var i = 5; i < 25; i++)
          {
            'id': 'run_$i',
            'scheduleId': 'sch_1',
            'source': 'schedule',
            'status': 'succeeded',
            'threadId': 'th_$i',
            'runId': 'r_$i',
            'error': null,
            'triggeredAt': '2026-11-25T09:00:00.000Z',
            'finishedAt': '2026-11-25T09:00:45.000Z',
          },
      ];

      final host = _ScheduleManageHost(runsBySchedule: {'sch_1': runs});
      final conn = _FakeScheduleConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      String? openedThreadId;
      await tester.pumpWidget(
        _wrap(
          ScheduleManageScreen(
            connectionListenable: notifier,
            onOpenThread: (threadId) => openedThreadId = threadId,
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Open runs sheet.
      await tester.tap(find.byKey(ScheduleManageScreen.runsKey('sch_1')));
      await tester.pumpAndSettle();

      expect(find.text('运行记录'), findsWidgets);
      expect(find.text('成功'), findsWidgets);
      expect(find.text('已跳过'), findsOneWidget);
      expect(find.text('会话在忙'), findsOneWidget);
      expect(find.text('失败'), findsOneWidget);
      expect(find.text('Agent 用不了'), findsOneWidget);
      expect(find.text('定时触发'), findsWidgets);
      expect(find.text('手动运行'), findsWidgets);
      expect(find.byKey(ScheduleRunsSheet.runTileKey('run_24')), findsNothing);

      // Scroll to bottom of sheet and load more.
      Finder sheetScrollable() => find
          .descendant(
            of: find.byType(ScheduleRunsSheet),
            matching: find.byType(Scrollable),
          )
          .first;

      await _reveal(
        tester,
        find.byKey(ScheduleRunsSheet.loadMoreButtonKey),
        sheetScrollable(),
        delta: 400,
      );
      await tester.tap(find.byKey(ScheduleRunsSheet.loadMoreButtonKey));
      await tester.pumpAndSettle();

      final secondPageCall = host.calls.lastWhere(
        (c) => c.method == MobileScheduleMethods.runs,
      );
      expect(secondPageCall.params['offset'], 20);
      expect(secondPageCall.params['limit'], 20);
      await _reveal(
        tester,
        find.byKey(ScheduleRunsSheet.runTileKey('run_24')),
        sheetScrollable(),
        delta: 300,
      );
      expect(
        find.byKey(ScheduleRunsSheet.runTileKey('run_24')),
        findsOneWidget,
      );
      expect(find.byKey(ScheduleRunsSheet.loadMoreButtonKey), findsNothing);

      // Scroll back up to delete run_1 and open run_0's thread.
      await _reveal(
        tester,
        find.byKey(ScheduleRunsSheet.deleteRunKey('run_1')),
        sheetScrollable(),
        delta: -400,
      );
      await tester.tap(find.byKey(ScheduleRunsSheet.deleteRunKey('run_1')));
      await tester.pumpAndSettle();
      expect(
        host.calls.any(
          (c) =>
              c.method == MobileScheduleMethods.deleteRun &&
              c.params['id'] == 'run_1',
        ),
        isTrue,
      );
      expect(find.byKey(ScheduleRunsSheet.runTileKey('run_1')), findsNothing);

      await _reveal(
        tester,
        find.byKey(ScheduleRunsSheet.openThreadKey('run_0')),
        sheetScrollable(),
        delta: -300,
      );
      await tester.tap(find.byKey(ScheduleRunsSheet.openThreadKey('run_0')));
      await tester.pumpAndSettle();
      expect(openedThreadId, 'th_open_me');
      expect(find.byType(ScheduleRunsSheet), findsNothing);
    },
  );

  testWidgets(
    'ScheduleManageScreen shows offline banner, disables writes, reloads on reconnect, and renders dark theme',
    (tester) async {
      final host1 = _ScheduleManageHost();
      final host2 = _ScheduleManageHost();
      final conn1 = _FakeScheduleConnection(host1);
      final conn2 = _FakeScheduleConnection(host2);
      final notifier = ValueNotifier<MobileConnection?>(conn1);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _wrap(
          ScheduleManageScreen(connectionListenable: notifier),
          brightness: Brightness.dark,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(ManageOfflineBanner.bannerKey), findsNothing);
      expect(find.byKey(ScheduleManageScreen.cardKey('sch_1')), findsOneWidget);

      // Go offline -> banner shown and write controls disabled.
      notifier.value = null;
      await tester.pump();
      expect(find.byKey(ManageOfflineBanner.bannerKey), findsOneWidget);

      final createBtn = tester.widget<IconButton>(
        find.byKey(ScheduleManageScreen.createButtonKey),
      );
      expect(createBtn.onPressed, isNull);
      final toggle = tester.widget<Switch>(
        find.byKey(ScheduleManageScreen.toggleKey('sch_1')),
      );
      expect(toggle.onChanged, isNull);
      final runNowBtn = tester.widget<TextButton>(
        find.byKey(ScheduleManageScreen.runNowKey('sch_1')),
      );
      expect(runNowBtn.onPressed, isNull);

      // Reconnect with new connection -> banner clears and list reloads automatically.
      notifier.value = conn2;
      await tester.pumpAndSettle();
      expect(find.byKey(ManageOfflineBanner.bannerKey), findsNothing);
      expect(
        host2.calls.any((c) => c.method == MobileScheduleMethods.list),
        isTrue,
      );
    },
  );
}
