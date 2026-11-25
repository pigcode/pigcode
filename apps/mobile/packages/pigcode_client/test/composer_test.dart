import 'dart:async';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:test/test.dart';

const _time = '2026-11-25T10:00:00.000Z';

class _ComposerRpc implements HostRequests {
  final notificationsController = StreamController<Map<String, dynamic>>.broadcast(
    sync: true,
  );
  final calls = <(String, Map<String, Object?>)>[];
  Map<String, Object?>? nextSubscribeComposer;
  void Function()? onSubscribe;

  @override
  Stream<Map<String, dynamic>> get notifications =>
      notificationsController.stream;

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method, params));
    return switch (method) {
      MobileComposerMethods.switchAgent => {
        'instanceId': params['instanceId'],
        'agentId': 'claude',
        'modelId': params['modelId'],
        'permissionMode': 'auto-accept-edits',
        'planMode': false,
        'supportsPlanMode': true,
        'contextUsage': null,
      },
      MobileComposerMethods.setPermissionMode => {
        'instanceId': 'fake',
        'agentId': 'fake',
        'modelId': 'fake-sage',
        'permissionMode': params['permissionMode'],
        'planMode': false,
        'supportsPlanMode': true,
        'contextUsage': {
          'usedTokens': 12000,
          'maxTokens': 200000,
          'autoCompactTokens': 170000,
        },
      },
      MobileComposerMethods.setPlanMode => {
        'instanceId': 'fake',
        'agentId': 'fake',
        'modelId': 'fake-sage',
        'permissionMode': 'full-access',
        'planMode': params['planMode'],
        'supportsPlanMode': true,
        'contextUsage': null,
      },
      MobileTimelineMethods.subscribe => () {
        onSubscribe?.call();
        return {
          'page': {
            'events': [
              {
                'seq': 10,
                'runId': 'r1',
                'kind': 'run.started',
                'createdAt': _time,
              },
            ],
            'through': 10,
            'nextBefore': 10,
          },
          if (nextSubscribeComposer != null) 'composer': nextSubscribeComposer,
        };
      }(),
      MobileTimelineMethods.history => {
        'events': [
          {
            'seq': 2,
            'runId': 'r0',
            'kind': 'run.completed',
            'createdAt': _time,
          },
        ],
        'through': 10,
      },
      MobileTimelineMethods.unsubscribe => {'ok': true},
      _ => throw StateError('unexpected method: $method'),
    };
  }

  void pushComposer(String threadId, Map<String, Object?> composer) {
    notificationsController.add({
      'jsonrpc': '2.0',
      'method': MobileComposerMethods.composerChanged,
      'params': {'threadId': threadId, 'composer': composer},
    });
  }
}

void main() {
  test('encodes and decodes composer models and extended draft/run params', () {
    final composerJson = {
      'instanceId': 'claude-work',
      'agentId': 'claude',
      'modelId': 'claude-sonnet-4-5',
      'permissionMode': 'auto-accept-edits',
      'planMode': true,
      'supportsPlanMode': true,
      'contextUsage': {
        'usedTokens': 42000,
        'maxTokens': 200000,
        'autoCompactTokens': 170000,
      },
    };
    final composer = MobileThreadComposerState.fromJson(composerJson);
    expect(composer.toJson(), composerJson);

    final nullableComposer = MobileThreadComposerState.fromJson({
      'instanceId': 'fake',
      'agentId': 'fake',
      'modelId': null,
      'permissionMode': 'full-access',
      'planMode': false,
      'supportsPlanMode': false,
      'contextUsage': null,
    });
    expect(nullableComposer.modelId, isNull);
    expect(nullableComposer.contextUsage, isNull);
    expect(nullableComposer.toJson(), {
      'instanceId': 'fake',
      'agentId': 'fake',
      'permissionMode': 'full-access',
      'planMode': false,
      'supportsPlanMode': false,
    });

    final usageWithNulls = MobileContextUsage.fromJson({
      'usedTokens': 100,
      'maxTokens': null,
      'autoCompactTokens': null,
    });
    expect(usageWithNulls.usedTokens, 100);
    expect(usageWithNulls.maxTokens, isNull);
    expect(usageWithNulls.autoCompactTokens, isNull);

    expect(
      () => MobileContextUsage.fromJson({'usedTokens': -1}),
      throwsFormatException,
    );
    expect(
      () => MobileThreadComposerState.fromJson({
        ...composerJson,
        'extra': true,
      }),
      throwsFormatException,
    );

    final instance = MobileDraftInstance.fromJson({
      'instanceId': 'fake-work',
      'label': '工作区',
      'agentName': 'Fake Agent',
      'permissionModes': ['approval-required', 'full-access'],
      'defaultPermissionMode': 'full-access',
      'agentId': 'fake',
      'accentColor': '#3b82f6',
      'supportsPlanMode': true,
    });
    expect(instance.agentId, 'fake');
    expect(instance.accentColor, '#3b82f6');
    expect(instance.supportsPlanMode, isTrue);
    expect(instance.toJson()['supportsPlanMode'], isTrue);

    final legacyInstance = MobileDraftInstance.fromJson({
      'instanceId': 'fake',
      'label': 'Fake Agent',
      'agentName': 'Fake Agent',
      'permissionModes': ['full-access'],
      'defaultPermissionMode': 'full-access',
    });
    expect(legacyInstance.agentId, isNull);
    expect(legacyInstance.accentColor, isNull);
    expect(legacyInstance.supportsPlanMode, isNull);
    expect(legacyInstance.toJson().containsKey('agentId'), isFalse);

    final model = MobileDraftModel.fromJson({
      'id': 'fake-sage',
      'label': 'Fake Sage',
      'efforts': ['low', 'medium', 'high'],
      'fast': true,
      'ultracode': true,
    });
    expect(model.efforts, ['low', 'medium', 'high']);
    expect(model.fast, isTrue);
    expect(model.ultracode, isTrue);
    expect(model.toJson(), {
      'id': 'fake-sage',
      'label': 'Fake Sage',
      'efforts': ['low', 'medium', 'high'],
      'fast': true,
      'ultracode': true,
    });

    const ref = MobileThreadReference(threadId: 'th_ref', title: '参考会话');
    final startParams = MobileStartRunParams(
      commandId: '11111111-1111-4111-8111-111111111111',
      threadId: 'th_1',
      text: '继续处理',
      effort: 'high',
      fast: true,
      ultracode: true,
      references: const [ref],
    );
    expect(MobileStartRunParams.fromJson(startParams.toJson()).toJson(), {
      'commandId': '11111111-1111-4111-8111-111111111111',
      'threadId': 'th_1',
      'text': '继续处理',
      'effort': 'high',
      'fast': true,
      'ultracode': true,
      'references': [
        {'kind': 'thread', 'threadId': 'th_ref', 'title': '参考会话'},
      ],
    });

    const legacyStart = MobileStartRunParams(
      commandId: '11111111-1111-4111-8111-111111111111',
      threadId: 'th_1',
      text: '普通发送',
    );
    expect(legacyStart.toJson(), {
      'commandId': '11111111-1111-4111-8111-111111111111',
      'threadId': 'th_1',
      'text': '普通发送',
    });

    const draftParams = MobileDraftCreateParams(
      instanceId: 'fake',
      commandId: '22222222-2222-4222-8222-222222222222',
      projectId: 'pr_1',
      modelId: 'fake-sage',
      permissionMode: MobileDraftPermission.autoAcceptEdits,
      text: '创建会话',
      effort: 'max',
      fast: true,
      ultracode: true,
      planMode: true,
      references: [ref],
    );
    expect(MobileDraftCreateParams.fromJson(draftParams.toJson()).toJson(), {
      'instanceId': 'fake',
      'commandId': '22222222-2222-4222-8222-222222222222',
      'projectId': 'pr_1',
      'modelId': 'fake-sage',
      'permissionMode': 'auto-accept-edits',
      'text': '创建会话',
      'effort': 'max',
      'fast': true,
      'ultracode': true,
      'planMode': true,
      'references': [
        {'kind': 'thread', 'threadId': 'th_ref', 'title': '参考会话'},
      ],
    });
  });

  test('MobileComposerCommands calls Host RPC methods and decodes updated state', () async {
    final rpc = _ComposerRpc();
    final commands = MobileComposerCommands(rpc);

    final switched = await commands.switchAgent(
      threadId: 'th_1',
      instanceId: 'claude-work',
      modelId: 'claude-sonnet-4-5',
    );
    expect(switched.instanceId, 'claude-work');
    expect(switched.modelId, 'claude-sonnet-4-5');

    final perm = await commands.setPermissionMode(
      threadId: 'th_1',
      permissionMode: MobileDraftPermission.approvalRequired,
    );
    expect(perm.permissionMode, MobileDraftPermission.approvalRequired);
    expect(perm.contextUsage?.usedTokens, 12000);

    final plan = await commands.setPlanMode(threadId: 'th_1', planMode: true);
    expect(plan.planMode, isTrue);

    expect(
      rpc.calls.map((call) => {'method': call.$1, 'params': call.$2}).toList(),
      [
        {
          'method': MobileComposerMethods.switchAgent,
          'params': {
            'threadId': 'th_1',
            'instanceId': 'claude-work',
            'modelId': 'claude-sonnet-4-5',
          },
        },
        {
          'method': MobileComposerMethods.setPermissionMode,
          'params': {
            'threadId': 'th_1',
            'permissionMode': 'approval-required',
          },
        },
        {
          'method': MobileComposerMethods.setPlanMode,
          'params': {'threadId': 'th_1', 'planMode': true},
        },
      ],
    );

    await rpc.notificationsController.close();
  });

  test('MobileTimeline tracks composer state from subscribe, live thread.composer notices, and history loads', () async {
    final rpc = _ComposerRpc()
      ..nextSubscribeComposer = {
        'instanceId': 'fake',
        'agentId': 'fake',
        'modelId': 'fake-sage',
        'permissionMode': 'full-access',
        'planMode': false,
        'supportsPlanMode': true,
        'contextUsage': {
          'usedTokens': 5000,
          'maxTokens': 200000,
          'autoCompactTokens': null,
        },
      };

    final timeline = await MobileTimeline.open(rpc, 'th_1');
    expect(timeline.snapshot?.composer?.modelId, 'fake-sage');
    expect(timeline.snapshot?.composer?.contextUsage?.usedTokens, 5000);

    // Loading earlier history preserves composer.
    await timeline.loadEarlier();
    expect(timeline.snapshot?.events.map((e) => e.seq), [2, 10]);
    expect(timeline.snapshot?.composer?.contextUsage?.usedTokens, 5000);

    // Notice for another thread is ignored.
    rpc.pushComposer('th_other', {
      'instanceId': 'other',
      'agentId': 'other',
      'modelId': null,
      'permissionMode': 'approval-required',
      'planMode': true,
      'supportsPlanMode': true,
      'contextUsage': null,
    });
    expect(timeline.snapshot?.composer?.instanceId, 'fake');

    // Live thread.composer notice updates snapshot and emits on updates stream.
    final nextUpdate = timeline.updates.first;
    rpc.pushComposer('th_1', {
      'instanceId': 'claude-work',
      'agentId': 'claude',
      'modelId': 'claude-opus',
      'permissionMode': 'auto-accept-edits',
      'planMode': true,
      'supportsPlanMode': true,
      'contextUsage': null,
    });
    final updated = await nextUpdate;
    expect(updated.composer?.instanceId, 'claude-work');
    expect(updated.composer?.modelId, 'claude-opus');
    expect(updated.composer?.permissionMode, MobileDraftPermission.autoAcceptEdits);
    expect(updated.composer?.planMode, isTrue);
    expect(updated.composer?.contextUsage, isNull);
    expect(updated.events.map((e) => e.seq), [2, 10]);

    await timeline.close();
    await rpc.notificationsController.close();
  });

  test('MobileTimeline buffers thread.composer notices arriving during subscribe load', () async {
    final rpc = _ComposerRpc()
      ..nextSubscribeComposer = {
        'instanceId': 'fake',
        'agentId': 'fake',
        'modelId': 'fake-sage',
        'permissionMode': 'full-access',
        'planMode': false,
        'supportsPlanMode': true,
        'contextUsage': null,
      };
    rpc.onSubscribe = () {
      rpc.pushComposer('th_1', {
        'instanceId': 'fake',
        'agentId': 'fake',
        'modelId': 'fake-swift',
        'permissionMode': 'approval-required',
        'planMode': true,
        'supportsPlanMode': true,
        'contextUsage': {'usedTokens': 9000, 'maxTokens': 100000},
      });
    };

    final timeline = await MobileTimeline.open(rpc, 'th_1');
    expect(timeline.snapshot?.composer?.modelId, 'fake-swift');
    expect(
      timeline.snapshot?.composer?.permissionMode,
      MobileDraftPermission.approvalRequired,
    );
    expect(timeline.snapshot?.composer?.contextUsage?.usedTokens, 9000);

    await timeline.close();
    await rpc.notificationsController.close();
  });
}
