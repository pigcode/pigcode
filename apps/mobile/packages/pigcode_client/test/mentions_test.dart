import 'dart:async';

import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:test/test.dart';

class _MentionRpc implements HostRequests {
  final notificationsController =
      StreamController<Map<String, dynamic>>.broadcast(sync: true);
  final calls = <(String, Map<String, Object?>)>[];

  @override
  Stream<Map<String, dynamic>> get notifications =>
      notificationsController.stream;

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method, params));
    return switch (method) {
      MobileMentionMethods.searchPaths => {
        'entries': [
          {'path': 'lib/main.dart', 'kind': 'file'},
          {'path': 'lib', 'kind': 'dir'},
        ],
        'truncated': true,
      },
      MobileMentionMethods.agentCommands => {
        'commands': [
          {
            'name': 'review',
            'text': '/review',
            'kind': 'command',
            'description': 'Review pending changes',
            'argumentHint': '<branch>',
            'source': 'builtin',
          },
          {
            'name': 'deploy',
            'text': '/deploy',
            'kind': 'command',
            'description': 'Run project deploy command',
            'source': 'custom',
          },
          {
            'name': 'mattpocock-skills:tdd',
            'text': r'$mattpocock-skills:tdd',
            'kind': 'skill',
            'displayName': 'TDD',
            'description': 'Red-green-refactor workflow',
            'shortDescription': 'Test-driven development',
            'source': 'plugin',
          },
          {
            'name': 'lint',
            'text': r'$lint',
            'kind': 'skill',
            'description': 'Lint the repository',
            'source': 'project',
          },
        ],
        'truncated': false,
      },
      _ => throw StateError('unexpected method: $method'),
    };
  }
}

void main() {
  test('announces composer.mentions in mobile.hello capability list', () {
    expect(mobileClientFeatures, contains('composer.mentions'));
    expect(mobileClientFeatures, contains('composer.controls'));
    expect(MobileMentionMethods.searchPaths, 'workspace.searchPaths');
    expect(MobileMentionMethods.agentCommands, 'agent.commands');
  });

  test('encodes, decodes, and strictly validates searchPaths models', () {
    const params = MobileSearchPathsParams(
      projectId: 'pr_1',
      query: 'main',
      limit: 20,
      refresh: true,
    );
    expect(MobileSearchPathsParams.fromJson(params.toJson()).toJson(), {
      'projectId': 'pr_1',
      'query': 'main',
      'limit': 20,
      'refresh': true,
    });

    final defaultQuery = MobileSearchPathsParams.fromJson({'threadId': 'th_1'});
    expect(defaultQuery.threadId, 'th_1');
    expect(defaultQuery.projectId, isNull);
    expect(defaultQuery.query, '');
    expect(defaultQuery.toJson(), {'threadId': 'th_1', 'query': ''});

    // Reject missing scope, conflicting scope, out-of-range limit, oversized query, unknown fields.
    expect(
      () => MobileSearchPathsParams.fromJson({'query': 'a'}),
      throwsFormatException,
    );
    expect(
      () => MobileSearchPathsParams.fromJson({
        'threadId': 'th_1',
        'projectId': 'pr_1',
        'query': 'a',
      }),
      throwsFormatException,
    );
    expect(
      () => MobileSearchPathsParams.fromJson({'projectId': 'pr_1', 'limit': 0}),
      throwsFormatException,
    );
    expect(
      () => MobileSearchPathsParams.fromJson({
        'projectId': 'pr_1',
        'limit': mobileSearchPathsMaxLimit + 1,
      }),
      throwsFormatException,
    );
    expect(
      () => MobileSearchPathsParams.fromJson({
        'projectId': 'pr_1',
        'query': 'a' * (mobileSearchPathsQueryLimit + 1),
      }),
      throwsFormatException,
    );
    expect(
      () => MobileSearchPathsParams.fromJson({
        'projectId': 'pr_1',
        'extra': true,
      }),
      throwsFormatException,
    );

    final resultJson = {
      'entries': [
        {'path': 'src/app.ts', 'kind': 'file'},
        {'path': 'src', 'kind': 'dir'},
      ],
      'truncated': true,
    };
    final result = MobileSearchPathsResult.fromJson(resultJson);
    expect(result.truncated, isTrue);
    expect(result.entries.length, 2);
    expect(result.entries[0].kind, MobilePathEntryKind.file);
    expect(result.entries[1].kind, MobilePathEntryKind.dir);
    expect(result.toJson(), resultJson);

    expect(
      () => MobilePathEntry.fromJson({'path': 'src', 'kind': 'directory'}),
      throwsFormatException,
    );
    expect(
      () => MobilePathEntry.fromJson({'path': '', 'kind': 'file'}),
      throwsFormatException,
    );
    expect(
      () => MobilePathEntry.fromJson({
        'path': 'src/app.ts',
        'kind': 'file',
        'extra': 1,
      }),
      throwsFormatException,
    );
    expect(
      () => MobileSearchPathsResult.fromJson({...resultJson, 'extra': 1}),
      throwsFormatException,
    );
  });

  test(
    'encodes, decodes, and strictly validates agentCommands models and / vs \$ distinction',
    () {
      const params = MobileAgentCommandsParams(
        instanceId: 'claude-work',
        threadId: 'th_1',
        refresh: true,
      );
      expect(MobileAgentCommandsParams.fromJson(params.toJson()).toJson(), {
        'instanceId': 'claude-work',
        'threadId': 'th_1',
        'refresh': true,
      });

      final unscoped = MobileAgentCommandsParams.fromJson({
        'instanceId': 'fake',
      });
      expect(unscoped.threadId, isNull);
      expect(unscoped.projectId, isNull);
      expect(unscoped.toJson(), {'instanceId': 'fake'});

      expect(
        () => MobileAgentCommandsParams.fromJson({
          'instanceId': 'fake',
          'threadId': 'th_1',
          'projectId': 'pr_1',
        }),
        throwsFormatException,
      );
      expect(
        () => MobileAgentCommandsParams.fromJson({'instanceId': ''}),
        throwsFormatException,
      );
      expect(
        () => MobileAgentCommandsParams.fromJson({
          'instanceId': 'fake',
          'extra': true,
        }),
        throwsFormatException,
      );

      final slashJson = {
        'name': 'compact',
        'text': '/compact',
        'kind': 'command',
        'description': 'Compact context',
        'argumentHint': '[focus]',
        'source': 'builtin',
      };
      final slash = MobileAgentCommand.fromJson(slashJson);
      expect(slash.isSlashCommand, isTrue);
      expect(slash.isSkill, isFalse);
      expect(slash.source, MobileAgentCommandSource.builtin);
      expect(slash.toJson(), slashJson);

      final skillJson = {
        'name': 'tdd',
        'text': r'$tdd',
        'kind': 'skill',
        'displayName': 'TDD',
        'description': 'Test-driven development',
        'shortDescription': 'Red-green-refactor',
        'source': 'plugin',
      };
      final skill = MobileAgentCommand.fromJson(skillJson);
      expect(skill.isSkill, isTrue);
      expect(skill.isSlashCommand, isFalse);
      expect(skill.source, MobileAgentCommandSource.plugin);
      expect(skill.toJson(), skillJson);

      // Mismatched / vs $ prefix is rejected.
      expect(
        () => MobileAgentCommand.fromJson({
          'name': 'compact',
          'text': r'$compact',
          'kind': 'command',
        }),
        throwsFormatException,
      );
      expect(
        () => MobileAgentCommand.fromJson({
          'name': 'tdd',
          'text': '/tdd',
          'kind': 'skill',
        }),
        throwsFormatException,
      );
      // Host-only fields like filesystem path or unknown keys are rejected.
      expect(
        () => MobileAgentCommand.fromJson({
          ...skillJson,
          'path': '/Users/me/.claude/skills/tdd/SKILL.md',
        }),
        throwsFormatException,
      );
      expect(
        () => MobileAgentCommandsResult.fromJson({
          'commands': [slashJson, skillJson],
          'truncated': false,
          'extra': 1,
        }),
        throwsFormatException,
      );
    },
  );

  test(
    'MobileMentionCommands calls workspace.searchPaths and agent.commands RPCs and validates client arguments',
    () async {
      final rpc = _MentionRpc();
      final mentions = MobileMentionCommands(rpc);

      final paths = await mentions.searchPaths(
        projectId: 'pr_1',
        query: 'main',
        limit: 10,
        refresh: true,
      );
      expect(paths.truncated, isTrue);
      expect(paths.entries.map((e) => (e.path, e.kind)), [
        ('lib/main.dart', MobilePathEntryKind.file),
        ('lib', MobilePathEntryKind.dir),
      ]);

      final emptyQueryPaths = await mentions.searchPaths(threadId: 'th_1');
      expect(emptyQueryPaths.entries.length, 2);

      final catalog = await mentions.agentCommands(
        instanceId: 'claude',
        projectId: 'pr_1',
        refresh: true,
      );
      expect(catalog.truncated, isFalse);
      final slashCommands = catalog.commands
          .where((cmd) => cmd.isSlashCommand)
          .toList();
      final skills = catalog.commands.where((cmd) => cmd.isSkill).toList();
      expect(slashCommands.map((c) => (c.text, c.source)), [
        ('/review', MobileAgentCommandSource.builtin),
        ('/deploy', MobileAgentCommandSource.custom),
      ]);
      expect(skills.map((c) => (c.text, c.displayName, c.source)), [
        (r'$mattpocock-skills:tdd', 'TDD', MobileAgentCommandSource.plugin),
        (r'$lint', null, MobileAgentCommandSource.project),
      ]);

      expect(rpc.calls.map((c) => {'method': c.$1, 'params': c.$2}).toList(), [
        {
          'method': MobileMentionMethods.searchPaths,
          'params': {
            'projectId': 'pr_1',
            'query': 'main',
            'limit': 10,
            'refresh': true,
          },
        },
        {
          'method': MobileMentionMethods.searchPaths,
          'params': {'threadId': 'th_1', 'query': ''},
        },
        {
          'method': MobileMentionMethods.agentCommands,
          'params': {
            'instanceId': 'claude',
            'projectId': 'pr_1',
            'refresh': true,
          },
        },
      ]);

      // Client-side guard prevents invalid scope combinations.
      await expectLater(() => mentions.searchPaths(), throwsArgumentError);
      await expectLater(
        () => mentions.searchPaths(threadId: 'th_1', projectId: 'pr_1'),
        throwsArgumentError,
      );
      await expectLater(
        () => mentions.searchPaths(projectId: 'pr_1', limit: 51),
        throwsRangeError,
      );
      await expectLater(
        () => mentions.agentCommands(
          instanceId: 'claude',
          threadId: 'th_1',
          projectId: 'pr_1',
        ),
        throwsArgumentError,
      );
      await expectLater(
        () => mentions.agentCommands(instanceId: ''),
        throwsArgumentError,
      );

      await rpc.notificationsController.close();
    },
  );
}
