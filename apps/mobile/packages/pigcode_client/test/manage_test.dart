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
  test('mobileClientFeatures advertises projects.manage and agents.manage', () {
    expect(mobileClientFeatures, contains('projects.manage'));
    expect(mobileClientFeatures, contains('agents.manage'));
    expect(mobileClientFeatures.length, lessThanOrEqualTo(32));
  });

  test('MobileProjectManageClient parses browseDirs, list, add, rename, remove', () async {
    final host = _StubHost()
      ..handlers = {
        MobileProjectMethods.list: (_) => {
          'projects': [
            {
              'id': 'pr_1',
              'name': 'Pigcode',
              'displayPath': '~/Documents/pigcode',
              'createdAt': '2026-11-26T00:00:00.000Z',
              'threadCount': 3,
            },
          ],
        },
        MobileProjectMethods.browseDirs: (p) => {
          'currentRelPath': p['relPath'] ?? '',
          'displayPath': p['relPath'] == null ? '~' : '~/${p['relPath']}',
          'parentRelPath': p['relPath'] == null ? null : '',
          'shortcuts': [
            {'label': '主目录', 'relPath': '', 'displayPath': '~'},
          ],
          'entries': [
            {
              'name': 'pigcode',
              'relPath': 'Documents/pigcode',
              'isGitRepo': true,
              'alreadyAddedProjectId': 'pr_1',
              'hasChildren': true,
            },
          ],
          'truncated': false,
        },
        MobileProjectMethods.add: (p) => {
          'project': {
            'id': 'pr_2',
            'name': p['name'] ?? 'beta',
            'displayPath': '~/${p['relPath']}',
            'createdAt': '2026-11-26T01:00:00.000Z',
            'threadCount': 0,
          },
        },
        MobileProjectMethods.rename: (p) => {
          'project': {
            'id': p['projectId'],
            'name': p['name'],
            'displayPath': '~/Documents/beta',
            'createdAt': '2026-11-26T01:00:00.000Z',
            'threadCount': 0,
          },
        },
        MobileProjectMethods.remove: (p) => {
          'removed': true,
          'projectId': p['projectId'],
        },
      };

    final client = MobileProjectManageClient(host, supportsProjectManage: true);
    final projects = await client.list();
    expect(projects.single.displayPath, '~/Documents/pigcode');
    expect(projects.single.threadCount, 3);

    final dir = await client.browseDirs(relPath: 'Documents');
    expect(dir.displayPath, '~/Documents');
    expect(dir.entries.single.isGitRepo, isTrue);
    expect(dir.entries.single.alreadyAddedProjectId, 'pr_1');

    final added = await client.add(relPath: 'Documents/beta', name: '  Beta  ');
    expect(added.id, 'pr_2');
    expect(added.name, 'Beta');

    final renamed = await client.rename(projectId: 'pr_2', name: 'Beta 2');
    expect(renamed.name, 'Beta 2');

    await client.remove(projectId: 'pr_2');
    expect(host.calls.last.method, MobileProjectMethods.remove);

    final unsupported = MobileProjectManageClient(
      host,
      supportsProjectManage: false,
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
  });

  test('MobileAgentManageClient parses localized fields, detect, models, and CRUD', () async {
    final host = _StubHost()
      ..handlers = {
        MobileAgentMethods.list: (_) => {
          'defaultAgentId': 'demo',
          'defaultInstanceId': 'demo',
          'agents': [
            {
              'agentId': 'demo',
              'displayName': 'Demo Agent',
              'pluginId': '@pigcode/agent-demo',
              'version': '1.0.0',
              'builtin': true,
              'enabled': true,
              'registered': true,
              'requiresInstance': false,
              'acpRegistry': false,
              'secretReferences': true,
              'customModels': true,
              'description': {'zh-CN': '演示代理', 'en': 'Demo'},
              'fields': [
                {
                  'key': 'apiKey',
                  'type': 'secret',
                  'label': {'zh-CN': 'API 密钥', 'en': 'API Key'},
                },
                {
                  'key': 'mode',
                  'type': 'select',
                  'label': '模式',
                  'options': [
                    {'value': 'fast', 'label': {'zh-CN': '快速'}},
                  ],
                },
              ],
              'error': null,
              'instances': [
                {
                  'instanceId': 'demo',
                  'agentId': 'demo',
                  'label': 'Demo Agent',
                  'enabled': true,
                  'isDefault': true,
                  'values': {'apiKey': {'configured': true}},
                },
              ],
            },
          ],
        },
        MobileAgentMethods.detect: (_) => {
          'statuses': {
            'demo': {
              'installed': true,
              'version': '2.0.0',
              'authenticated': true,
              'account': 'Pro',
            },
          },
        },
        MobileAgentMethods.models: (_) => {
          'models': [
            {'id': 'm1', 'name': 'Model 1', 'isCustom': false, 'hidden': false},
            {'id': 'm2', 'name': 'm2', 'isCustom': true, 'hidden': true},
          ],
        },
        MobileAgentMethods.setDefault: (p) => {
          'defaultAgentId': p['agentId'],
          'defaultInstanceId': p['instanceId'],
        },
        MobileAgentMethods.createInstance: (p) => {
          'instance': {
            'instanceId': p['instanceId'] ?? 'demo-custom',
            'agentId': p['agentId'],
            'label': p['label'],
            'accentColor': p['accentColor'],
            'enabled': true,
            'isDefault': false,
            'values': {'apiKey': {'configured': true}},
          },
        },
        MobileAgentMethods.updateInstance: (p) => {
          'instance': {
            'instanceId': p['instanceId'],
            'agentId': 'demo',
            'label': (p['patch'] as Map)['label'] ?? 'Work',
            'enabled': (p['patch'] as Map)['enabled'] ?? true,
            'isDefault': false,
            'values': {'apiKey': {'configured': true}},
          },
        },
        MobileAgentMethods.removeInstance: (p) => {
          'removed': true,
          'instanceId': p['instanceId'],
        },
      };

    final client = MobileAgentManageClient(host, supportsAgentManage: true);
    final listed = await client.list();
    expect(listed.agents.single.description, '演示代理');
    expect(listed.agents.single.fields.first.label, 'API 密钥');
    expect(listed.agents.single.fields.last.options.single.label, '快速');

    final statuses = await client.detect(refresh: true);
    expect(statuses['demo']?.installed, isTrue);
    expect(statuses['demo']?.account, 'Pro');

    final models = await client.models(instanceId: 'demo');
    expect(models.last.isCustom, isTrue);
    expect(models.last.hidden, isTrue);

    final created = await client.createInstance(
      agentId: 'demo',
      label: '工作号',
      instanceId: 'demo-work',
      accentColor: '#2563eb',
      values: {'apiKey': {'secret': 'sk-test'}},
    );
    expect(created.instanceId, 'demo-work');

    final updated = await client.updateInstance(
      instanceId: 'demo-work',
      enabled: false,
      clearAccentColor: true,
    );
    expect(updated.enabled, isFalse);
    expect(
      (host.calls.last.params['patch'] as Map)['accentColor'],
      isNull,
    );
    expect(
      (host.calls.last.params['patch'] as Map).containsKey('accentColor'),
      isTrue,
    );

    final def = await client.setDefault(agentId: null);
    expect(def.defaultAgentId, isNull);

    await client.removeInstance(instanceId: 'demo-work');
    expect(host.calls.last.method, MobileAgentMethods.removeInstance);

    final unsupported = MobileAgentManageClient(
      host,
      supportsAgentManage: false,
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
  });
}
