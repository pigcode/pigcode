import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/manage/agent_instance_editor_screen.dart';
import 'package:pigcode_mobile/manage/agent_manage_screen.dart';
import 'package:pigcode_mobile/manage/manage_utils.dart';
import 'package:pigcode_mobile/manage/settings_hub_screen.dart';

class _AgentManageHost implements HostRequests {
  final List<({String method, Map<String, Object?> params})> calls = [];
  String? defaultAgentId = 'claude';
  String? defaultInstanceId;
  int detectCount = 0;

  List<Map<String, dynamic>> instances = [
    {
      'instanceId': 'claude',
      'agentId': 'claude',
      'label': 'Claude Code',
      'enabled': true,
      'isDefault': true,
      'values': <String, dynamic>{
        'apiKey': {'configured': true},
        'modelHint': 'sonnet',
      },
    },
    {
      'instanceId': 'claude-work',
      'agentId': 'claude',
      'label': '公司号',
      'accentColor': '#2563eb',
      'enabled': true,
      'isDefault': false,
      'values': <String, dynamic>{
        'apiKey': {'configured': true},
        'maxTurns': '12',
        'verbose': true,
        'env': [
          {
            'name': 'TOKEN',
            'value': {'configured': true},
            'sensitive': true,
          },
        ],
        'customModels': ['claude-custom-1'],
        'hiddenModels': <String>[],
      },
    },
  ];

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: Map<String, Object?>.from(params)));
    switch (method) {
      case MobileAgentMethods.list:
        return {
          'defaultAgentId': defaultAgentId,
          'defaultInstanceId': defaultInstanceId,
          'agents': [
            {
              'agentId': 'claude',
              'displayName': 'Claude Code',
              'pluginId': 'pigcode.agent.claude',
              'version': '1.2.0',
              'builtin': true,
              'enabled': true,
              'registered': true,
              'requiresInstance': false,
              'acpRegistry': false,
              'accountSetup': false,
              'secretReferences': true,
              'customModels': true,
              'description': {'zh-CN': 'Anthropic 官方编码 Agent'},
              'fields': [
                {
                  'key': 'apiKey',
                  'type': 'secret',
                  'label': {'zh-CN': 'API Key'},
                },
                {
                  'key': 'maxTurns',
                  'type': 'text',
                  'label': {'zh-CN': '最大轮次'},
                  'integerRange': {'min': 1, 'max': 100},
                },
                {
                  'key': 'verbose',
                  'type': 'boolean',
                  'label': {'zh-CN': '详细日志'},
                },
                {
                  'key': 'modelHint',
                  'type': 'select',
                  'label': {'zh-CN': '默认预设'},
                  'options': [
                    {'value': 'sonnet', 'label': 'Sonnet'},
                    {'value': 'opus', 'label': 'Opus'},
                  ],
                },
                {
                  'key': 'env',
                  'type': 'env',
                  'label': {'zh-CN': '环境变量'},
                },
              ],
              'error': null,
              'instances': instances,
            },
          ],
        };
      case MobileAgentMethods.detect:
        detectCount++;
        return {
          'statuses': {
            'claude': {
              'installed': true,
              'version': detectCount > 1 ? '2.1.0' : '2.0.0',
              'authenticated': true,
              'account': 'Max · claude.ai',
            },
            'claude-work': {
              'installed': true,
              'version': '2.1.0',
              'authenticated': true,
              'credentialsConfigured': true,
            },
          },
        };
      case MobileAgentMethods.models:
        final instId = params['instanceId'] as String?;
        final inst = instances.firstWhere(
          (i) => i['instanceId'] == instId,
          orElse: () => instances.first,
        );
        final vals = inst['values'] as Map<String, dynamic>;
        final custom = (vals['customModels'] as List?)?.cast<String>() ?? [];
        final hidden = (vals['hiddenModels'] as List?)?.cast<String>() ?? [];
        return {
          'models': [
            {
              'id': 'claude-sonnet-4-6',
              'name': 'Claude Sonnet 4.6',
              'isCustom': false,
              'hidden': hidden.contains('claude-sonnet-4-6'),
            },
            for (final id in custom)
              {
                'id': id,
                'name': id,
                'isCustom': true,
                'hidden': hidden.contains(id),
              },
          ],
        };
      case MobileAgentMethods.setDefault:
        defaultAgentId = params['agentId'] as String?;
        defaultInstanceId = params['instanceId'] as String?;
        return {
          'defaultAgentId': defaultAgentId,
          'defaultInstanceId': defaultInstanceId,
        };
      case MobileAgentMethods.createInstance:
        final requestedId = params['instanceId'] as String?;
        if (requestedId != null &&
            instances.any((i) => i['instanceId'] == requestedId)) {
          throw const MobileRpcFailure(
            MobileRpcProblem(
              code: 'AGENT_INSTANCE_ID_TAKEN',
              message: 'Instance ID already exists',
              retryable: false,
            ),
          );
        }
        final created = <String, dynamic>{
          'instanceId': requestedId ?? 'claude-2',
          'agentId': params['agentId'] as String,
          'label': (params['label'] as String).isEmpty
              ? 'Claude #2'
              : params['label'],
          if (params['accentColor'] != null)
            'accentColor': params['accentColor'],
          'enabled': true,
          'isDefault': false,
          'values': Map<String, dynamic>.from(
            (params['values'] as Map?) ?? const {},
          ),
        };
        instances = [...instances, created];
        return {'instance': created};
      case MobileAgentMethods.updateInstance:
        final id = params['instanceId'] as String;
        final patch = params['patch'] as Map<String, Object?>;
        final idx = instances.indexWhere((i) => i['instanceId'] == id);
        final cur = Map<String, dynamic>.from(instances[idx]);
        if (patch.containsKey('label')) cur['label'] = patch['label'];
        if (patch.containsKey('accentColor')) {
          if (patch['accentColor'] == null) {
            cur.remove('accentColor');
          } else {
            cur['accentColor'] = patch['accentColor'];
          }
        }
        if (patch.containsKey('enabled')) cur['enabled'] = patch['enabled'];
        if (patch.containsKey('values')) {
          cur['values'] = Map<String, dynamic>.from(patch['values']! as Map);
        }
        instances = [
          for (var i = 0; i < instances.length; i++)
            i == idx ? cur : instances[i],
        ];
        return {'instance': cur};
      case MobileAgentMethods.removeInstance:
        final id = params['instanceId'] as String;
        instances = instances.where((i) => i['instanceId'] != id).toList();
        return {'removed': true, 'instanceId': id};
      default:
        throw StateError('Unexpected method: $method');
    }
  }
}

class _FakeAgentConnection implements MobileConnection {
  _FakeAgentConnection(HostRequests host)
    : projects = MobileProjectManageClient(host, supportsProjectManage: true),
      agents = MobileAgentManageClient(host, supportsAgentManage: true);

  @override
  String get computerName => 'StudioMac';
  @override
  bool get supportsProjectManage => true;
  @override
  bool get supportsAgentManage => true;
  @override
  final MobileProjectManageClient projects;
  @override
  final MobileAgentManageClient agents;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Widget _wrap(Widget home) =>
    MaterialApp(theme: pigcodeTheme(Brightness.light), home: home);

void main() {
  testWidgets(
    'AgentManageScreen detects, sets default, toggles custom instance, and survives reconnect',
    (tester) async {
      final host1 = _AgentManageHost();
      final host2 = _AgentManageHost();
      final conn1 = _FakeAgentConnection(host1);
      final conn2 = _FakeAgentConnection(host2);
      final notifier = ValueNotifier<MobileConnection?>(conn1);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _wrap(
          SettingsHubScreen(
            connectionListenable: notifier,
            computerName: 'StudioMac',
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Navigate into AgentManageScreen from SettingsHubScreen.
      await tester.tap(find.byKey(SettingsHubScreen.agentsTileKey));
      await tester.pumpAndSettle();

      expect(find.text('Claude Code'), findsWidgets);
      expect(find.text('公司号'), findsOneWidget);
      expect(
        find.textContaining('已安装 2.0.0 · Max · claude.ai'),
        findsOneWidget,
      );

      // Default instance hides enable toggle; custom instance exposes toggle.
      expect(find.byKey(AgentManageScreen.toggleKey('claude')), findsNothing);
      expect(
        find.byKey(AgentManageScreen.toggleKey('claude-work')),
        findsOneWidget,
      );

      // Refresh detect updates status version.
      await tester.tap(find.byKey(AgentManageScreen.refreshDetectButtonKey));
      await tester.pumpAndSettle();
      expect(find.textContaining('已安装 2.1.0'), findsWidgets);

      // Switch default agent to custom instance then to auto.
      await tester.tap(find.byKey(AgentManageScreen.defaultCardKey));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(AgentManageScreen.defaultOptionKey('claude-work')),
      );
      await tester.pumpAndSettle();
      expect(host1.defaultAgentId, 'claude');
      expect(host1.defaultInstanceId, 'claude-work');

      await tester.tap(find.byKey(AgentManageScreen.defaultCardKey));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(AgentManageScreen.defaultAutoOptionKey));
      await tester.pumpAndSettle();
      expect(host1.defaultAgentId, isNull);

      // Toggle custom instance off.
      await tester.tap(find.byKey(AgentManageScreen.toggleKey('claude-work')));
      await tester.pumpAndSettle();
      final toggled = host1.instances.firstWhere(
        (i) => i['instanceId'] == 'claude-work',
      );
      expect(toggled['enabled'], isFalse);

      // Disconnect -> offline banner; reconnect -> reloads via host2.
      notifier.value = null;
      await tester.pump();
      expect(find.byKey(ManageOfflineBanner.bannerKey), findsOneWidget);
      notifier.value = conn2;
      await tester.pumpAndSettle();
      expect(find.byKey(ManageOfflineBanner.bannerKey), findsNothing);
      expect(
        host2.calls.any((c) => c.method == MobileAgentMethods.list),
        isTrue,
      );
    },
  );

  testWidgets(
    'AgentInstanceEditorScreen creates custom instance, handles ID conflict, preserves configured secret, edits models, and deletes',
    (tester) async {
      final host = _AgentManageHost();
      final conn = _FakeAgentConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _wrap(AgentManageScreen(connectionListenable: notifier)),
      );
      await tester.pumpAndSettle();

      // 1. Create custom instance: test ID conflict first, then succeed.
      await tester.tap(find.byKey(AgentManageScreen.createButtonKey('claude')));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(AgentInstanceEditorScreen.labelInputKey),
        '个人备用',
      );
      await tester.enterText(
        find.byKey(AgentInstanceEditorScreen.instanceIdInputKey),
        'claude-work',
      );
      await tester.tap(
        find.byKey(AgentInstanceEditorScreen.colorSwatchKey('#059669')),
      );
      await tester.tap(find.byKey(AgentInstanceEditorScreen.saveButtonKey));
      await tester.pumpAndSettle();
      expect(find.textContaining('已被使用'), findsOneWidget);

      await tester.enterText(
        find.byKey(AgentInstanceEditorScreen.instanceIdInputKey),
        'claude-personal',
      );
      await tester.tap(find.byKey(AgentInstanceEditorScreen.saveButtonKey));
      await tester.pumpAndSettle();
      expect(find.text('个人备用'), findsOneWidget);

      // 2. Edit default instance: no delete button, preserves configured secret, never sends label/accentColor.
      await tester.tap(find.byKey(AgentManageScreen.instanceTileKey('claude')));
      await tester.pumpAndSettle();
      expect(
        find.byKey(AgentInstanceEditorScreen.deleteButtonKey),
        findsNothing,
      );
      expect(find.textContaining('已配置'), findsOneWidget);

      await tester.tap(find.byKey(AgentInstanceEditorScreen.saveButtonKey));
      await tester.pumpAndSettle();
      final defaultUpdate = host.calls.lastWhere(
        (c) => c.method == MobileAgentMethods.updateInstance,
      );
      final defaultPatch =
          defaultUpdate.params['patch']! as Map<String, Object?>;
      expect(defaultPatch.containsKey('label'), isFalse);
      expect(defaultPatch.containsKey('accentColor'), isFalse);
      expect((defaultPatch['values']! as Map)['apiKey'], const {
        'configured': true,
      });

      // 3. Edit custom instance: replace secret, add custom model, hide builtin model, then delete.
      await tester.tap(
        find.byKey(AgentManageScreen.instanceTileKey('claude-work')),
      );
      await tester.pumpAndSettle();

      Finder listScrollable() => find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first;

      await tester.scrollUntilVisible(
        find.byKey(AgentInstanceEditorScreen.secretReplaceKey('apiKey')),
        200,
        scrollable: listScrollable(),
      );
      await tester.tap(
        find.byKey(AgentInstanceEditorScreen.secretReplaceKey('apiKey')),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(AgentInstanceEditorScreen.fieldKey('apiKey')),
        'sk-new-secret',
      );

      await tester.scrollUntilVisible(
        find.byKey(AgentInstanceEditorScreen.customModelInputKey),
        200,
        scrollable: listScrollable(),
      );
      await tester.enterText(
        find.byKey(AgentInstanceEditorScreen.customModelInputKey),
        'claude-opus-custom',
      );
      await tester.tap(
        find.byKey(AgentInstanceEditorScreen.customModelAddButtonKey),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(
          AgentInstanceEditorScreen.modelSwitchKey('claude-sonnet-4-6'),
        ),
        200,
        scrollable: listScrollable(),
      );
      await tester.tap(
        find.byKey(
          AgentInstanceEditorScreen.modelSwitchKey('claude-sonnet-4-6'),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(AgentInstanceEditorScreen.saveButtonKey));
      await tester.pumpAndSettle();

      final workUpdate = host.calls.lastWhere(
        (c) =>
            c.method == MobileAgentMethods.updateInstance &&
            c.params['instanceId'] == 'claude-work',
      );
      final workValues = (workUpdate.params['patch']! as Map)['values']! as Map;
      expect(workValues['apiKey'], const {'secret': 'sk-new-secret'});
      expect(
        workValues[mobileAgentCustomModelsKey],
        contains('claude-opus-custom'),
      );
      expect(
        workValues[mobileAgentHiddenModelsKey],
        contains('claude-sonnet-4-6'),
      );

      // 4. Delete custom instance with confirmation.
      await tester.tap(
        find.byKey(AgentManageScreen.instanceTileKey('claude-personal')),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(AgentInstanceEditorScreen.deleteButtonKey),
        300,
        scrollable: listScrollable(),
      );
      await tester.drag(listScrollable(), const Offset(0, -200));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(AgentInstanceEditorScreen.deleteButtonKey));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(AgentInstanceEditorScreen.deleteConfirmKey));
      await tester.pumpAndSettle();

      expect(find.text('个人备用'), findsNothing);
      expect(
        host.calls.any(
          (c) =>
              c.method == MobileAgentMethods.removeInstance &&
              c.params['instanceId'] == 'claude-personal',
        ),
        isTrue,
      );
    },
  );

  testWidgets(
    'AgentInstanceEditorScreen collapses long model catalogs until expanded',
    (tester) async {
      final host = _LargeModelCatalogHost();
      final conn = _FakeAgentConnection(host);
      final notifier = ValueNotifier<MobileConnection?>(conn);
      addTearDown(notifier.dispose);

      await tester.pumpWidget(
        _wrap(
          AgentInstanceEditorScreen(
            connectionListenable: notifier,
            agent: const MobileAgentSummary(
              agentId: 'claude',
              displayName: 'Claude Code',
              builtin: true,
              enabled: true,
              registered: true,
              requiresInstance: false,
              acpRegistry: false,
              secretReferences: false,
              customModels: true,
              fields: [],
              instances: [],
            ),
            instance: const MobileAgentInstance(
              instanceId: 'claude-extra',
              agentId: 'claude',
              label: '多模型实例',
              enabled: true,
              isDefault: false,
              values: {},
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('展开全部 10 个模型'), findsOneWidget);
      expect(find.text('Model 9'), findsNothing);

      await tester.ensureVisible(
        find.byKey(const ValueKey('agent-editor-models-toggle')),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('agent-editor-models-toggle')),
      );
      await tester.pumpAndSettle();
      expect(find.text('收起模型列表'), findsOneWidget);
      expect(find.text('Model 9'), findsOneWidget);
    },
  );
}

class _LargeModelCatalogHost implements HostRequests {
  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    if (method == MobileAgentMethods.models) {
      return {
        'models': [
          for (var i = 0; i < 10; i++)
            {
              'id': 'model-$i',
              'name': 'Model $i',
              'isCustom': false,
              'hidden': false,
            },
        ],
      };
    }
    throw StateError('Unexpected method: $method');
  }
}
