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
  test(
    'mobileClientFeatures advertises schedules.manage and plugins.manage',
    () {
      expect(mobileClientFeatures, contains('schedules.manage'));
      expect(mobileClientFeatures, contains('plugins.manage'));
      expect(mobileClientFeatures.length, lessThanOrEqualTo(32));
    },
  );

  test(
    'all 12 MobileScheduleRule variants round-trip JSON and format Chinese summaries',
    () {
      const anchor = '2026-11-26T00:00:00.000Z';
      final cases = <({MobileScheduleRule rule, String summary})>[
        (
          rule: const MobileScheduleRuleHourly(minute: 15),
          summary: '每小时第 15 分',
        ),
        (
          rule: const MobileScheduleRuleDaily(time: '09:00'),
          summary: '每天 09:00',
        ),
        (
          rule: const MobileScheduleRuleWeekdays(time: '09:30'),
          summary: '工作日 09:30',
        ),
        (
          rule: const MobileScheduleRuleWeekly(days: [5, 1, 3], time: '10:00'),
          summary: '每周一、三、五 10:00',
        ),
        (
          rule: const MobileScheduleRuleMonthly(day: 15, time: '08:00'),
          summary: '每月 15 日 08:00',
        ),
        (
          rule: const MobileScheduleRuleEveryMinutes(every: 30, anchor: anchor),
          summary: '每 30 分钟',
        ),
        (
          rule: const MobileScheduleRuleEveryHours(
            every: 4,
            minute: 20,
            anchor: anchor,
          ),
          summary: '每 4 小时第 20 分',
        ),
        (
          rule: const MobileScheduleRuleEveryDays(
            every: 2,
            time: '09:00',
            anchor: anchor,
          ),
          summary: '每 2 天 09:00',
        ),
        (
          rule: const MobileScheduleRuleEveryWeeks(
            every: 2,
            days: [0, 1],
            time: '18:30',
            anchor: anchor,
          ),
          summary: '每 2 周 一、日 18:30',
        ),
        (
          rule: const MobileScheduleRuleEveryMonths(
            every: 3,
            days: [15, 1],
            time: '09:00',
            anchor: anchor,
          ),
          summary: '每 3 个月 1、15 日 09:00',
        ),
        (
          rule: const MobileScheduleRuleEveryMonthsWeekday(
            every: 2,
            weekday: 1,
            time: '10:00',
            anchor: anchor,
          ),
          summary: '每 2 个月首个周一 10:00',
        ),
        (
          rule: const MobileScheduleRuleEveryYears(
            every: 1,
            month: 5,
            day: 1,
            time: '08:00',
            anchor: anchor,
          ),
          summary: '每 1 年 5 月 1 日 08:00',
        ),
      ];

      expect(cases, hasLength(12));
      for (final entry in cases) {
        final encoded = entry.rule.toJson();
        final decoded = MobileScheduleRule.fromJson(
          Map<String, dynamic>.from(encoded),
        );
        expect(decoded.kind, entry.rule.kind);
        expect(decoded.toJson(), encoded);
        expect(describeScheduleRule(decoded), entry.summary);
      }

      expect(
        () => MobileScheduleRule.fromJson({'kind': 'daily', 'time': '25:00'}),
        throwsFormatException,
      );
      expect(
        () => MobileScheduleRule.fromJson({'kind': 'hourly', 'minute': 60}),
        throwsFormatException,
      );
      expect(
        () => MobileScheduleRule.fromJson({'kind': 'unknown'}),
        throwsFormatException,
      );
    },
  );

  test(
    'MobileScheduleManageClient covers all 7 RPC methods and feature gating',
    () async {
      const now = '2026-11-26T09:00:00.000Z';
      Map<String, Object?> sampleSchedule({
        String id = 'sch_1',
        String title = '每日巡检',
        bool enabled = true,
        String? endsAt,
      }) => {
        'id': id,
        'target': {
          'kind': 'project',
          'projectId': 'pr_1',
          'execution': {
            'instanceId': 'claude',
            'modelId': 'claude-sonnet',
            'effort': 'medium',
            'permissionMode': 'full-access',
          },
        },
        'projectName': 'Pigcode',
        'threadTitle': null,
        'title': title,
        'prompt': '检查 CI',
        'rule': {'kind': 'daily', 'time': '09:00'},
        'endsAt': endsAt,
        'enabled': enabled,
        'status': enabled ? 'active' : 'paused',
        'nextRunAt': now,
        'lastRunAt': null,
        'lastRunId': null,
        'runCount': 0,
        'createdAt': now,
        'updatedAt': now,
      };

      final host = _StubHost()
        ..handlers = {
          MobileScheduleMethods.list: (_) => {
            'schedules': [sampleSchedule()],
            'truncated': false,
          },
          MobileScheduleMethods.create: (p) => sampleSchedule(
            id: 'sch_2',
            title: (p['title'] as String?) ?? '',
            endsAt: p['endsAt'] as String?,
          ),
          MobileScheduleMethods.update: (p) => sampleSchedule(
            id: p['id'] as String,
            title: (p['title'] as String?) ?? '每日巡检',
            enabled: (p['enabled'] as bool?) ?? true,
            endsAt: p['endsAt'] as String?,
          ),
          MobileScheduleMethods.delete: (_) => {'deleted': true},
          MobileScheduleMethods.runNow: (_) => {
            'status': 'started',
            'runId': 'run_1',
          },
          MobileScheduleMethods.runs: (_) => {
            'total': 1,
            'runs': [
              {
                'id': 'srun_1',
                'scheduleId': 'sch_2',
                'source': 'manual',
                'status': 'succeeded',
                'threadId': 'th_1',
                'runId': 'run_1',
                'error': null,
                'triggeredAt': now,
                'finishedAt': now,
              },
            ],
          },
          MobileScheduleMethods.deleteRun: (_) => {'deleted': true},
        };

      final client = MobileScheduleManageClient(
        host,
        supportsScheduleManage: true,
      );

      final listed = await client.list();
      expect(listed.truncated, isFalse);
      expect(listed.schedules.single.projectName, 'Pigcode');
      expect(
        listed.schedules.single.target,
        isA<MobileScheduleProjectTarget>(),
      );

      final created = await client.create(
        projectId: 'pr_1',
        title: '  新建巡检  ',
        prompt: '  跑单测  ',
        rule: const MobileScheduleRuleWeekdays(time: '09:30'),
        execution: const MobileScheduleExecution(
          instanceId: 'claude',
          modelId: 'claude-sonnet',
        ),
      );
      expect(created.id, 'sch_2');
      expect(created.title, '新建巡检');

      final updated = await client.update(
        id: 'sch_2',
        enabled: false,
        clearEndsAt: true,
      );
      expect(updated.enabled, isFalse);
      expect(host.calls.last.params.containsKey('endsAt'), isTrue);
      expect(host.calls.last.params['endsAt'], isNull);

      final runNow = await client.runNow(id: 'sch_2');
      expect(runNow.status, MobileScheduleRunNowStatus.started);
      expect(runNow.runId, 'run_1');

      final runsPage = await client.runs(id: 'sch_2', limit: 10, offset: 0);
      expect(runsPage.total, 1);
      expect(runsPage.runs.single.status, MobileScheduleRunStatus.succeeded);

      expect(await client.deleteRun(id: 'srun_1'), isTrue);
      expect(await client.delete(id: 'sch_2'), isTrue);

      final unsupported = MobileScheduleManageClient(
        host,
        supportsScheduleManage: false,
      );
      await expectLater(
        unsupported.list(),
        throwsA(
          isA<MobileRpcFailure>().having(
            (e) => e.problem.code,
            'code',
            'METHOD_NOT_AVAILABLE',
          ),
        ),
      );
    },
  );

  test(
    'MobilePluginManageClient covers all 7 RPC methods, i18n resolution, semver update detection, and gating',
    () async {
      Map<String, Object?> samplePlugin({
        String id = 'ui.demo',
        String version = '1.0.0',
        bool enabled = true,
        bool builtin = false,
      }) => {
        'id': id,
        'name': 'demo',
        'displayName': 'Demo Plugin',
        'description': 'Desc',
        'version': version,
        'kind': 'ui',
        'enabled': enabled,
        'builtin': builtin,
        'apiVersion': 1,
        'permissions': ['workspace.read'],
        'provides': <String>[],
        'conflict': null,
        'error': null,
        'originKind': builtin ? 'builtin' : 'marketplace',
        'marketplaceId': builtin ? null : 'pigcode',
        'marketplacePluginName': builtin ? null : 'demo',
        'originLabel': builtin ? null : 'demo@pigcode',
        'canUpdate': !builtin,
      };

      Map<String, Object?> sampleMarketplace() => {
        'id': 'pigcode',
        'official': true,
        'displayName': 'Pigcode 官方市场',
        'description': 'Official',
        'owner': 'Pigcode',
        'sourceType': 'url',
        'sourceLabel': 'https://marketplace.pigcode.dev/marketplace.json',
        'sourceUrl': 'https://github.com/pigcode/marketplace',
        'enabled': true,
        'lastUpdated': '2026-11-26T00:00:00.000Z',
        'error': null,
        'plugins': [
          {
            'name': 'demo',
            'displayName': 'Demo Fallback',
            'description': 'English Desc',
            'version': '1.2.0',
            'category': 'tools',
            'iconUrl': 'https://cdn.pigcode.dev/demo.png',
            'homepage': 'https://pigcode.dev',
            'author': 'Pigcode',
            'publisherType': 'official',
            'displayNameI18n': {'zh-CN': '中文演示', 'en': 'English Demo'},
            'descriptionI18n': {'zh': '简体描述', 'en': 'English Desc'},
            'sourceLabel': 'https://cdn.pigcode.dev/demo.tgz',
          },
          {
            'name': 'en-only',
            'displayName': 'Plain Name',
            'description': 'Plain Desc',
            'version': '1.0.0',
            'category': null,
            'iconUrl': null,
            'homepage': null,
            'author': null,
            'publisherType': 'community',
            'displayNameI18n': {'en': 'English Title'},
            'sourceLabel': 'en-only',
          },
        ],
      };

      final host = _StubHost()
        ..handlers = {
          MobilePluginMethods.list: (_) => {
            'plugins': [samplePlugin()],
            'truncated': false,
          },
          MobilePluginMethods.setEnabled: (p) => {
            'plugin': samplePlugin(
              id: p['id'] as String,
              enabled: p['enabled'] as bool,
            ),
          },
          MobilePluginMethods.update: (p) => {
            'plugin': samplePlugin(id: p['id'] as String, version: '1.2.0'),
          },
          MobilePluginMethods.uninstall: (_) => {'uninstalled': true},
          MobilePluginMethods.marketplaces: (_) => {
            'marketplaces': [sampleMarketplace()],
            'truncated': false,
          },
          MobilePluginMethods.refreshMarketplaces: (_) => {
            'marketplaces': [sampleMarketplace()],
            'truncated': false,
          },
          MobilePluginMethods.installFromMarketplace: (_) => {
            'plugin': samplePlugin(version: '1.2.0'),
          },
        };

      final client = MobilePluginManageClient(host, supportsPluginManage: true);

      final listed = await client.list();
      expect(listed.truncated, isFalse);
      final installed = listed.plugins.single;
      expect(installed.canUpdate, isTrue);

      final markets = await client.marketplaces();
      final market = markets.marketplaces.single;
      final zhEntry = market.plugins[0];
      final enEntry = market.plugins[1];
      expect(zhEntry.localizedDisplayName, '中文演示');
      expect(zhEntry.localizedDescription, '简体描述');
      expect(enEntry.localizedDisplayName, 'English Title');
      expect(enEntry.localizedDescription, 'Plain Desc');

      // Semver comparison and update check
      expect(compareSemver('1.2.0', '1.0.0'), greaterThan(0));
      expect(compareSemver('1.0.0', '1.0.0-beta.1'), greaterThan(0));
      expect(compareSemver('1.0.0', '1.0.0'), 0);
      expect(compareSemver('0.9.9', '1.0.0'), lessThan(0));
      expect(hasPluginUpdate(installed, market, zhEntry), isTrue);

      final refreshed = await client.refreshMarketplaces(
        id: 'pigcode',
        ifStale: true,
      );
      expect(refreshed.marketplaces, hasLength(1));

      final toggled = await client.setEnabled(id: 'ui.demo', enabled: false);
      expect(toggled.enabled, isFalse);

      final updated = await client.update(id: 'ui.demo');
      expect(updated.version, '1.2.0');
      expect(hasPluginUpdate(updated, market, zhEntry), isFalse);

      final freshlyInstalled = await client.installFromMarketplace(
        marketplace: 'pigcode',
        name: 'demo',
      );
      expect(freshlyInstalled.version, '1.2.0');

      await client.uninstall(id: 'ui.demo');
      expect(host.calls.last.method, MobilePluginMethods.uninstall);

      final unsupported = MobilePluginManageClient(
        host,
        supportsPluginManage: false,
      );
      await expectLater(
        unsupported.list(),
        throwsA(
          isA<MobileRpcFailure>().having(
            (e) => e.problem.code,
            'code',
            'METHOD_NOT_AVAILABLE',
          ),
        ),
      );
    },
  );
}
