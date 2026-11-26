import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/composer/composer_mentions.dart';
import 'package:pigcode_mobile/composer/composer_suggestion_panel.dart';
import 'package:pigcode_mobile/composer/composer_tokens.dart';
import 'package:pigcode_mobile/composer/mention_editing_controller.dart';
import 'package:pigcode_mobile/composer/mobile_composer_card.dart';
import 'package:pigcode_mobile/new_thread_draft.dart';
import 'package:pigcode_mobile/run_composer.dart';
import 'package:pigcode_mobile/timeline_pane.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

const _projects = [
  MobileProjectSummary(id: 'proj-a', name: '主工程'),
  MobileProjectSummary(id: 'proj-b', name: '文档仓库'),
];

const _threads = [
  MobileThreadSummary(
    id: 'thread-current',
    projectId: 'proj-a',
    title: '当前正在看的会话',
    updatedAt: '2026-11-25T08:00:00Z',
    archived: false,
    pinned: false,
    status: MobileThreadStatus.completed,
    unread: false,
  ),
  MobileThreadSummary(
    id: 'thread-1',
    projectId: 'proj-a',
    title: '排查连接超时',
    updatedAt: '2026-11-25T07:50:00Z',
    archived: false,
    pinned: false,
    status: MobileThreadStatus.completed,
    unread: false,
  ),
  MobileThreadSummary(
    id: 'thread-2',
    projectId: 'proj-a',
    title: '修复列表滚动',
    updatedAt: '2026-11-25T07:40:00Z',
    archived: false,
    pinned: false,
    status: MobileThreadStatus.completed,
    unread: false,
  ),
  MobileThreadSummary(
    id: 'thread-3',
    projectId: 'proj-a',
    title: '调整字体大小',
    updatedAt: '2026-11-25T07:30:00Z',
    archived: false,
    pinned: false,
    status: MobileThreadStatus.completed,
    unread: false,
  ),
  MobileThreadSummary(
    id: 'thread-4',
    projectId: 'proj-a',
    title: '完善单测覆盖',
    updatedAt: '2026-11-25T07:20:00Z',
    archived: false,
    pinned: false,
    status: MobileThreadStatus.completed,
    unread: false,
  ),
  MobileThreadSummary(
    id: 'thread-5',
    projectId: 'proj-a',
    title: '优化启动速度',
    updatedAt: '2026-11-25T07:10:00Z',
    archived: false,
    pinned: false,
    status: MobileThreadStatus.completed,
    unread: false,
  ),
  MobileThreadSummary(
    id: 'thread-6',
    projectId: 'proj-a',
    title: '第六条超限会话',
    updatedAt: '2026-11-25T07:00:00Z',
    archived: false,
    pinned: false,
    status: MobileThreadStatus.completed,
    unread: false,
  ),
  MobileThreadSummary(
    id: 'thread-archived',
    projectId: 'proj-a',
    title: '旧版配对记录',
    updatedAt: '2026-11-24T08:00:00Z',
    archived: true,
    pinned: false,
    status: MobileThreadStatus.completed,
    unread: false,
  ),
  MobileThreadSummary(
    id: 'thread-other-project',
    projectId: 'proj-b',
    title: '文档配对指南',
    updatedAt: '2026-11-24T09:00:00Z',
    archived: false,
    pinned: false,
    status: MobileThreadStatus.completed,
    unread: false,
  ),
];

const _claudeInstance = MobileDraftInstance(
  instanceId: 'claude',
  agentId: 'claude',
  label: 'Claude Code',
  agentName: 'Claude Code',
  accentColor: '#d97757',
  supportsPlanMode: true,
  permissionModes: [
    MobileDraftPermission.approvalRequired,
    MobileDraftPermission.autoAcceptEdits,
    MobileDraftPermission.auto,
    MobileDraftPermission.fullAccess,
  ],
  defaultPermissionMode: MobileDraftPermission.approvalRequired,
);

const _claudeModels = MobileDraftModels(
  defaultModelId: 'opus',
  models: [
    MobileDraftModel(
      id: 'opus',
      label: 'Claude Opus 4.6',
      efforts: ['low', 'medium', 'high'],
      fast: true,
      ultracode: true,
    ),
  ],
);

const _defaultPaths = [
  MobilePathEntry(path: 'lib/app.dart', kind: MobilePathEntryKind.file),
  MobilePathEntry(
    path: 'lib/composer/composer_tokens.dart',
    kind: MobilePathEntryKind.file,
  ),
  MobilePathEntry(path: 'Makefile', kind: MobilePathEntryKind.file),
  MobilePathEntry(path: 'docs', kind: MobilePathEntryKind.dir),
];

const _defaultAgentCommands = [
  MobileAgentCommand(
    name: 'model',
    text: '/model',
    kind: MobileAgentCommandKind.command,
    description: '远程同名模型命令（应被内置覆盖）',
    source: MobileAgentCommandSource.builtin,
  ),
  MobileAgentCommand(
    name: 'compact',
    text: '/compact',
    kind: MobileAgentCommandKind.command,
    description: '压缩上下文',
    argumentHint: '[instructions]',
    source: MobileAgentCommandSource.builtin,
  ),
  MobileAgentCommand(
    name: 'deploy',
    text: '/deploy',
    kind: MobileAgentCommandKind.command,
    description: '部署到测试环境',
    source: MobileAgentCommandSource.project,
  ),
  MobileAgentCommand(
    name: 'code-review',
    text: r'$code-review',
    kind: MobileAgentCommandKind.skill,
    displayName: '代码审查',
    shortDescription: '按规范审查当前改动',
    source: MobileAgentCommandSource.project,
  ),
  MobileAgentCommand(
    name: 'write-tests',
    text: r'$write-tests',
    kind: MobileAgentCommandKind.skill,
    displayName: '补充单测',
    description: '为代码审查中发现的缺口编写单元测试',
    source: MobileAgentCommandSource.user,
  ),
  MobileAgentCommand(
    name: 'plugin-lint',
    text: r'$plugin-lint',
    kind: MobileAgentCommandKind.skill,
    displayName: '插件校验',
    shortDescription: '检查插件清单',
    source: MobileAgentCommandSource.plugin,
  ),
  MobileAgentCommand(
    name: 'sys-diag',
    text: r'$sys-diag',
    kind: MobileAgentCommandKind.skill,
    displayName: '系统诊断',
    shortDescription: '排查系统环境',
    source: MobileAgentCommandSource.system,
  ),
];

class _MentionHost implements HostRequests {
  _MentionHost({
    MobileThreadComposerState? initialComposer,
    this.searchPathsHandler,
    this.agentCommandsHandler,
  }) : composerState =
           initialComposer ??
           const MobileThreadComposerState(
             instanceId: 'claude',
             agentId: 'claude',
             modelId: 'opus',
             permissionMode: MobileDraftPermission.approvalRequired,
             planMode: false,
             supportsPlanMode: true,
           );

  final calls = <({String method, Map<String, Object?> params})>[];
  final Future<MobileSearchPathsResult> Function(Map<String, Object?> params)?
  searchPathsHandler;
  final Future<MobileAgentCommandsResult> Function(Map<String, Object?> params)?
  agentCommandsHandler;
  MobileThreadComposerState composerState;

  @override
  Stream<Map<String, dynamic>> get notifications => const Stream.empty();

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: Map<String, Object?>.from(params)));
    switch (method) {
      case MobileDraftMethods.options:
        return const MobileDraftOptions(
          defaultInstanceId: 'claude',
          instances: [_claudeInstance],
        ).toJson();
      case MobileDraftMethods.models:
        return _claudeModels.toJson();
      case MobileDraftMethods.create:
        return MobileDraftReceipt(
          method: MobileDraftMethods.create,
          commandId: params['commandId'] as String,
          projectId: params['projectId'] as String,
          threadId: 'created-thread',
          title: params['text'] as String,
          runId: 'run-1',
        ).toJson();
      case MobileCommandMethods.start:
        return MobileRunReceipt(
          method: MobileRunMethod.runStart,
          commandId: params['commandId'] as String,
          threadId: params['threadId'] as String,
          runId: 'run-next',
        ).toJson();
      case MobileCommandMethods.receipt:
        return const <String, dynamic>{};
      case QueueMethods.get:
        return QueueSnapshot(
          threadId: params['threadId'] as String,
          paused: false,
          messages: const [],
        ).toJson();
      case MobileComposerMethods.setPlanMode:
        composerState = MobileThreadComposerState(
          instanceId: composerState.instanceId,
          agentId: composerState.agentId,
          modelId: composerState.modelId,
          permissionMode: composerState.permissionMode,
          planMode: params['planMode'] as bool,
          supportsPlanMode: composerState.supportsPlanMode,
        );
        return composerState.toJson();
      case MobileComposerMethods.setPermissionMode:
        composerState = MobileThreadComposerState(
          instanceId: composerState.instanceId,
          agentId: composerState.agentId,
          modelId: composerState.modelId,
          permissionMode: MobileDraftPermission.fromWire(
            params['permissionMode'] as String,
          ),
          planMode: composerState.planMode,
          supportsPlanMode: composerState.supportsPlanMode,
        );
        return composerState.toJson();
      case MobileMentionMethods.searchPaths:
        if (searchPathsHandler != null) {
          return (await searchPathsHandler!(params)).toJson();
        }
        final query = (params['query'] as String? ?? '').toLowerCase();
        final filtered = query.isEmpty
            ? _defaultPaths
            : _defaultPaths
                  .where((e) => e.path.toLowerCase().contains(query))
                  .toList();
        return MobileSearchPathsResult(
          entries: filtered,
          truncated: false,
        ).toJson();
      case MobileMentionMethods.agentCommands:
        if (agentCommandsHandler != null) {
          return (await agentCommandsHandler!(params)).toJson();
        }
        return const MobileAgentCommandsResult(
          commands: _defaultAgentCommands,
          truncated: false,
        ).toJson();
      default:
        throw StateError('Unexpected RPC method: $method');
    }
  }
}

class _MentionTimeline implements MobileTimeline {
  _MentionTimeline(this.snapshot);

  @override
  final TimelineSnapshot snapshot;

  @override
  Stream<TimelineSnapshot> get updates => const Stream.empty();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _MentionConnection implements MobileConnection {
  _MentionConnection(
    this.host, {
    this.supportsComposerControls = true,
    this.supportsComposerMentions = true,
  }) : drafts = MobileDraftCommands(host),
       composer = MobileComposerCommands(host),
       mentions = MobileMentionCommands(host),
       runCommands = MobileRunCommands(host),
       queue = MobileQueueCommands(host);

  final _MentionHost host;

  @override
  final bool supportsComposerControls;
  @override
  final bool supportsComposerMentions;
  @override
  bool get supportsQueueCommands => true;
  @override
  bool get supportsRunCommands => true;
  @override
  bool get supportsRequestCommands => false;
  @override
  bool get supportsRunChanges => false;
  @override
  bool get supportsSidebarCommands => false;
  @override
  final MobileDraftCommands drafts;
  @override
  final MobileComposerCommands composer;
  @override
  final MobileMentionCommands mentions;
  @override
  final MobileRunCommands runCommands;
  @override
  final MobileQueueCommands queue;
  @override
  final computer = ComputerProfile(
    address: 'wss://localhost/ws/v1/connect',
    token: 'fixture',
    computerKey: base64Url.encode(List<int>.filled(32, 7)).replaceAll('=', ''),
    name: '开发电脑',
  );
  @override
  String get deviceId => 'phone-1';

  @override
  Future<MobileTimeline> openTimeline(
    String threadId, {
    TimelineSnapshot? resumeFrom,
  }) async => _MentionTimeline(
    TimelineSnapshot(
      events: const [],
      through: 0,
      cursor: 0,
      nextBefore: null,
      live: null,
      composer: host.composerState,
    ),
  );

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _LegacyStubConnection implements MobileConnection {
  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

TextEditingValue _collapsed(String text, [int? offset]) => TextEditingValue(
  text: text,
  selection: TextSelection.collapsed(offset: offset ?? text.length),
);

List<TextSpan> _flattenSpans(InlineSpan root) {
  final out = <TextSpan>[];
  void walk(InlineSpan span) {
    if (span is TextSpan) {
      if (span.text != null && span.text!.isNotEmpty) {
        out.add(span);
      }
      final children = span.children;
      if (children != null) {
        for (final child in children) {
          walk(child);
        }
      }
    }
  }

  walk(root);
  return out;
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  group('Pure trigger detection, insertion, path splitting & ranking', () {
    test('detectComposerTrigger respects line-start / and boundary @ / \$', () {
      expect(
        detectComposerTrigger(_collapsed('/mod')),
        const ComposerTriggerMatch(
          kind: ComposerTriggerKind.command,
          start: 0,
          end: 4,
          query: 'mod',
        ),
      );
      expect(
        detectComposerTrigger(_collapsed('第一行\n/plan')),
        const ComposerTriggerMatch(
          kind: ComposerTriggerKind.command,
          start: 4,
          end: 9,
          query: 'plan',
        ),
      );
      expect(detectComposerTrigger(_collapsed('hello /plan')), isNull);
      expect(detectComposerTrigger(_collapsed('/plan ')), isNull);

      expect(
        detectComposerTrigger(_collapsed('查看 @lib/a')),
        const ComposerTriggerMatch(
          kind: ComposerTriggerKind.mention,
          start: 3,
          end: 9,
          query: 'lib/a',
        ),
      );
      expect(detectComposerTrigger(_collapsed('a@b.com')), isNull);

      expect(
        detectComposerTrigger(_collapsed('运行 \$rev')),
        const ComposerTriggerMatch(
          kind: ComposerTriggerKind.skill,
          start: 3,
          end: 7,
          query: 'rev',
        ),
      );
      expect(detectComposerTrigger(_collapsed('foo\$bar')), isNull);

      // 非折叠选区或无效选区不触发。
      expect(
        detectComposerTrigger(
          const TextEditingValue(
            text: '@lib',
            selection: TextSelection(baseOffset: 0, extentOffset: 4),
          ),
        ),
        isNull,
      );
      expect(
        detectComposerTrigger(const TextEditingValue(text: '@lib')),
        isNull,
      );
    });

    test('applyComposerTriggerInsertion & insertComposerTriggerCharacter', () {
      final value = const TextEditingValue(
        text: '看下 @lib',
        selection: TextSelection.collapsed(offset: 7),
        composing: TextRange(start: 3, end: 7),
      );
      final match = detectComposerTrigger(value)!;
      final replaced = applyComposerTriggerInsertion(
        value,
        match,
        '@lib/app.dart ',
      );
      expect(replaced.text, '看下 @lib/app.dart ');
      expect(replaced.selection, const TextSelection.collapsed(offset: 17));
      expect(replaced.composing, TextRange.empty);

      // 空文本插入 / 直接放在行首；非空文本插入 / 自动换行触发。
      expect(
        insertComposerTriggerCharacter(
          _collapsed(''),
          ComposerTriggerKind.command,
        ).text,
        '/',
      );
      expect(
        insertComposerTriggerCharacter(
          _collapsed('已有文字'),
          ComposerTriggerKind.command,
        ).text,
        '已有文字\n/',
      );
      // 非空白前插入 @ / $ 自动补空格。
      expect(
        insertComposerTriggerCharacter(
          _collapsed('已有文字'),
          ComposerTriggerKind.mention,
        ).text,
        '已有文字 @',
      );
      expect(
        insertComposerTriggerCharacter(
          _collapsed('已有文字 '),
          ComposerTriggerKind.skill,
        ).text,
        r'已有文字 $',
      );
    });

    test(
      'connectionSupportsComposerMentions degrades safely on legacy stub',
      () {
        expect(connectionSupportsComposerMentions(null), isFalse);
        expect(
          connectionSupportsComposerMentions(_LegacyStubConnection()),
          isFalse,
        );
      },
    );

    test('splitComposerPath splits filename and directory cleanly', () {
      expect(splitComposerPath('lib/composer/composer_tokens.dart'), (
        name: 'composer_tokens.dart',
        dir: 'lib/composer',
      ));
      expect(splitComposerPath('README.md'), (name: 'README.md', dir: ''));
      expect(splitComposerPath('lib/composer/'), (
        name: 'composer/',
        dir: 'lib',
      ));
    });

    test(
      'matchComposerThreads prioritizes same-project unarchived and searches globally with query',
      () {
        final emptyQuery = matchComposerThreads(
          threads: _threads,
          projects: _projects,
          currentProjectId: 'proj-a',
          currentThreadId: 'thread-current',
          query: '',
        );
        // 自动排除当前会话、归档会话与跨项目会话，最多 5 条。
        expect(emptyQuery.map((t) => t.id), [
          'thread-1',
          'thread-2',
          'thread-3',
          'thread-4',
          'thread-5',
        ]);

        // 输入关键词后跨项目且包含已归档会话。
        final searched = matchComposerThreads(
          threads: _threads,
          projects: _projects,
          currentProjectId: 'proj-a',
          currentThreadId: 'thread-current',
          query: '配对',
        );
        expect(searched.map((t) => t.id), [
          'thread-archived',
          'thread-other-project',
        ]);
        expect(searched[0].archived, isTrue);
        expect(searched[1].sameProject, isFalse);
        expect(searched[1].projectName, '文档仓库');
      },
    );

    test(
      'buildSlashCommandSuggestions merges builtins first and excludes fullAccess',
      () {
        final builtins = buildComposerBuiltinCommands(
          canOpenModelPicker: true,
          supportsPlanMode: true,
          permissionModes: const [
            MobileDraftPermission.approvalRequired,
            MobileDraftPermission.autoAcceptEdits,
            MobileDraftPermission.auto,
            MobileDraftPermission.fullAccess,
          ],
        );
        expect(builtins.map((b) => b.label), [
          '/plan',
          '/model',
          '/approval-required',
          '/auto-accept-edits',
          '/auto',
        ]);

        final merged = buildSlashCommandSuggestions(
          builtins: builtins,
          agentCommands: _defaultAgentCommands,
          query: '',
        );
        // 同名 /model 内置优先且去重；非 builtin 远程命令 /deploy 排在 /compact 前。
        expect(merged.where((item) => item.label == '/model'), hasLength(1));
        expect(
          merged.firstWhere((item) => item.label == '/model').builtinCommand,
          isNotNull,
        );
        final deployIndex = merged.indexWhere((i) => i.label == '/deploy');
        final compactIndex = merged.indexWhere((i) => i.label == '/compact');
        expect(deployIndex, greaterThan(0));
        expect(compactIndex, greaterThan(deployIndex));

        // 支持中文关键词搜索内置命令。
        final cnSearch = buildSlashCommandSuggestions(
          builtins: builtins,
          agentCommands: _defaultAgentCommands,
          query: '模型',
        );
        expect(cnSearch.first.label, '/model');
      },
    );

    test(
      'buildSkillSuggestions ranks by name, displayName, description, and source',
      () {
        final byName = buildSkillSuggestions(
          agentCommands: _defaultAgentCommands,
          query: 'code-review',
        );
        expect(byName.first.agentCommand?.name, 'code-review');

        final byDisplay = buildSkillSuggestions(
          agentCommands: _defaultAgentCommands,
          query: '代码审查',
        );
        expect(byDisplay.first.agentCommand?.name, 'code-review');
        expect(
          byDisplay.map((i) => i.agentCommand?.name),
          contains('write-tests'),
        );

        final bySource = buildSkillSuggestions(
          agentCommands: _defaultAgentCommands,
          query: '插件',
        );
        expect(bySource.first.agentCommand?.name, 'plugin-lint');
        expect(bySource.first.tag, '插件');
      },
    );
  });

  group(
    'ComposerTextEditingController highlight, IME composing & reference cleanup',
    () {
      testWidgets(
        'highlights @thread, @file, \$skill in accentText without font metric shift and preserves IME composing underline',
        (tester) async {
          final controller = ComposerTextEditingController();
          addTearDown(controller.dispose);
          controller.recordThreadReference(
            const MobileThreadReference(threadId: 't1', title: '排查 连接超时'),
          );
          controller.recordFileMention('Makefile');
          const sampleText =
              r'参考 @排查 连接超时 和 @lib/app.dart 以及 @Makefile 用 $code-review，邮箱 a@b.com 价格 $100 正在输入';
          final composingStart = sampleText.indexOf('正在输入');
          controller.value = TextEditingValue(
            text: sampleText,
            selection: TextSelection.collapsed(offset: sampleText.length),
            composing: TextRange(start: composingStart, end: sampleText.length),
          );

          late TextSpan built;
          await tester.pumpWidget(
            MaterialApp(
              theme: pigcodeTheme(Brightness.light),
              home: Builder(
                builder: (context) {
                  built = controller.buildTextSpan(
                    context: context,
                    style: ComposerType.input.copyWith(
                      color: ComposerSurface.palette(
                        Brightness.light,
                      ).foreground,
                    ),
                    withComposing: true,
                  );
                  return const SizedBox.shrink();
                },
              ),
            ),
          );

          final expectedAccent = ComposerSurface.mentionHighlight(
            Brightness.light,
          );
          final spans = _flattenSpans(built);
          // 完整保留全部文本字符，绝不吞字。
          expect(spans.map((s) => s.text!).join(), controller.text);

          TextSpan spanOf(String text) =>
              spans.singleWhere((s) => s.text == text);

          for (final highlighted in [
            '@排查 连接超时',
            '@lib/app.dart',
            '@Makefile',
            r'$code-review',
          ]) {
            final s = spanOf(highlighted);
            expect(s.style?.color, expectedAccent);
            expect(s.style?.fontSize, ComposerType.input.fontSize);
            expect(s.style?.fontWeight, ComposerType.input.fontWeight);
            expect(s.style?.height, ComposerType.input.height);
          }

          // 邮箱与价格不高亮。
          expect(
            spans.any(
              (s) =>
                  s.text!.contains('a@b.com') &&
                  s.style?.color == expectedAccent,
            ),
            isFalse,
          );
          expect(
            spans.any(
              (s) =>
                  s.text!.contains(r'$100') && s.style?.color == expectedAccent,
            ),
            isFalse,
          );

          // 组合区保留完整下划线且文本未被切碎。
          final composingSpan = spanOf('正在输入');
          expect(composingSpan.style?.decoration, TextDecoration.underline);
        },
      );

      test(
        'resolveReferences deduplicates in order, caps at 10, and drops edited/deleted references',
        () {
          final controller = ComposerTextEditingController();
          addTearDown(controller.dispose);
          const refA = MobileThreadReference(threadId: 'a', title: '排查连接超时');
          const refB = MobileThreadReference(threadId: 'b', title: '修复列表滚动');
          controller.recordThreadReference(refA);
          controller.recordThreadReference(refB);
          controller.text = '先看 @修复列表滚动 再看 @排查连接超时 和 @修复列表滚动。';

          expect(controller.resolveReferences().map((r) => r.threadId), [
            'b',
            'a',
          ]);

          // 删掉一个字 -> 对应引用立即被剔除。
          controller.text = '先看 @修复列表滚动 再看 @排查连接超';
          expect(controller.resolveReferences().map((r) => r.threadId), ['b']);

          // 尾部粘连字母破坏边界 -> 自动剔除。
          controller.text = '先看 @修复列表滚动abc';
          expect(controller.resolveReferences(), isEmpty);

          // 超过 10 条唯一会话引用时截断至 10 条。
          controller.clear();
          expect(controller.trackedThreadReferences, isEmpty);
          final parts = <String>[];
          for (var i = 0; i < 12; i++) {
            final ref = MobileThreadReference(threadId: 't$i', title: '会话$i');
            controller.recordThreadReference(ref);
            parts.add('@会话$i');
          }
          controller.text = parts.join(' ');
          expect(controller.resolveReferences(), hasLength(10));
          expect(controller.resolveReferences().first.threadId, 't0');
          expect(controller.resolveReferences().last.threadId, 't9');

          // 文本清空同步清理内部跟踪记录。
          controller.text = '';
          expect(controller.trackedThreadReferences, isEmpty);
        },
      );
    },
  );

  group('RunComposer & TimelinePane mentions UI integration', () {
    testWidgets(
      r'opens attach menu (+), inserts @ / $, searches threads/files, sends structured references, and drops edited references',
      (tester) async {
        final host = _MentionHost();
        final connection = _MentionConnection(host);

        await tester.pumpWidget(
          ProviderScope(
            child: MaterialApp(
              theme: pigcodeTheme(
                Brightness.light,
              ).copyWith(platform: TargetPlatform.iOS),
              home: Scaffold(
                body: TimelinePane(
                  connection: connection,
                  threadId: 'thread-current',
                  projectId: 'proj-a',
                  projects: _projects,
                  threads: _threads,
                  online: true,
                  computerKey: connection.computer.computerKey,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final input = find.byKey(const ValueKey('run-composer-input'));
        final attach = find.byKey(MobileComposerAttachButton.buttonKey);
        expect(attach, findsOneWidget);

        // 先输入一段正文，再点 + -> 引用文件或会话，应自动补空格并立刻弹出 @ 面板。
        await tester.enterText(input, '请参考');
        await tester.pump();
        await tester.tap(attach);
        await tester.pumpAndSettle();
        expect(find.text('引用文件或会话'), findsOneWidget);
        expect(find.text('运行命令'), findsOneWidget);
        expect(find.text('使用 Skill'), findsOneWidget);

        await tester.tap(
          find.byKey(MobileComposerAttachButton.mentionOptionKey),
        );
        await tester.pumpAndSettle();

        // 联想面板出现在输入框卡片正上方，标题为「引用」且含「会话」「文件」分组。
        final panel = find.byKey(MobileComposerSuggestionPanel.panelKey);
        expect(panel, findsOneWidget);
        expect(
          tester.getBottomLeft(panel).dy,
          lessThanOrEqualTo(
            tester.getTopLeft(find.byKey(MobileComposerCard.cardKey)).dy,
          ),
        );
        expect(find.text('引用'), findsOneWidget);
        expect(find.text('会话'), findsOneWidget);
        expect(find.text('当前正在看的会话'), findsNothing);
        expect(find.text('排查连接超时'), findsOneWidget);
        // 列表限高可纵向滚动，向下滚动可见「文件」分组与文件条目。
        final panelList = find.descendant(
          of: panel,
          matching: find.byType(Scrollable),
        );
        await tester.scrollUntilVisible(
          find.text('app.dart'),
          120,
          scrollable: panelList,
        );
        expect(find.text('文件'), findsOneWidget);
        expect(find.text('app.dart'), findsOneWidget);
        await tester.scrollUntilVisible(
          find.text('排查连接超时'),
          -120,
          scrollable: panelList,
        );

        // 选中一个会话引用 -> 插入 `@排查连接超时 ` 并关闭面板。
        await tester.tap(find.text('排查连接超时'));
        await tester.pumpAndSettle();
        expect(panel, findsNothing);

        // 继续输入 `@配对` 跨项目匹配并带已归档标签。
        final field = tester.widget<TextField>(input);
        final controller = field.controller!;
        expect(controller.text, '请参考 @排查连接超时 ');

        await tester.enterText(input, '${controller.text}@配对');
        await tester.pump(const Duration(milliseconds: 160));
        await tester.pumpAndSettle();
        expect(find.text('旧版配对记录'), findsOneWidget);
        expect(find.text('已归档'), findsOneWidget);
        expect(find.text('文档配对指南'), findsOneWidget);
        expect(find.text('文档仓库'), findsOneWidget);

        // 选中跨项目会话并再选中一个文件。
        await tester.tap(find.text('文档配对指南'));
        await tester.pumpAndSettle();
        expect(controller.text, '请参考 @排查连接超时 @文档配对指南 ');

        await tester.enterText(input, '${controller.text}@app');
        await tester.pump(const Duration(milliseconds: 160));
        await tester.pumpAndSettle();
        await tester.tap(find.text('app.dart'));
        await tester.pumpAndSettle();
        expect(controller.text, '请参考 @排查连接超时 @文档配对指南 @lib/app.dart ');

        // 编辑删掉 `@排查连接超时` 的最后一个字，确认发送时自动剔除该失效引用！
        final edited = controller.text.replaceFirst('@排查连接超时', '@排查连接超');
        await tester.enterText(input, edited);
        await tester.pump();

        await tester.tap(find.byTooltip('发送消息'));
        await tester.pumpAndSettle();

        final startCall = host.calls.lastWhere(
          (c) => c.method == MobileCommandMethods.start,
        );
        expect(startCall.params['references'], [
          {
            'kind': 'thread',
            'threadId': 'thread-other-project',
            'title': '文档配对指南',
          },
        ]);
        // 发送受理后输入框清空，跟踪引用同步清空。
        expect(controller.text, isEmpty);
        expect(
          (controller as ComposerTextEditingController).trackedThreadReferences,
          isEmpty,
        );
      },
    );

    testWidgets(
      'supports / builtin commands (/model, /plan, permission) & remote slash commands and \$ skill insertion',
      (tester) async {
        final host = _MentionHost();
        final connection = _MentionConnection(host);

        await tester.pumpWidget(
          ProviderScope(
            child: MaterialApp(
              theme: pigcodeTheme(Brightness.light),
              home: Scaffold(
                body: Align(
                  alignment: Alignment.bottomCenter,
                  child: RunComposer(
                    connection: connection,
                    threadId: 'thread-current',
                    projectId: 'proj-a',
                    projects: _projects,
                    threads: _threads,
                    online: true,
                    composer: host.composerState,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final input = find.byKey(const ValueKey('run-composer-input'));
        final attach = find.byKey(MobileComposerAttachButton.buttonKey);

        // 点击 + -> 运行命令，立即弹出 / 联想面板。
        await tester.tap(attach);
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(MobileComposerAttachButton.commandOptionKey),
        );
        await tester.pumpAndSettle();

        final panel = find.byKey(MobileComposerSuggestionPanel.panelKey);
        expect(panel, findsOneWidget);
        expect(find.text('/plan'), findsOneWidget);
        expect(find.text('/model'), findsOneWidget);
        expect(find.text('/auto-accept-edits'), findsOneWidget);
        expect(find.text('/full-access'), findsNothing);
        final commandScrollable = find.descendant(
          of: panel,
          matching: find.byType(Scrollable),
        );
        await tester.scrollUntilVisible(
          find.text('/compact'),
          120,
          scrollable: commandScrollable,
        );
        expect(find.text('/compact'), findsOneWidget);
        await tester.scrollUntilVisible(
          find.text('/plan'),
          -120,
          scrollable: commandScrollable,
        );

        // 选中 /plan -> 切换计划模式并清除输入中的 /。
        await tester.tap(find.text('/plan'));
        await tester.pumpAndSettle();
        expect(
          host.calls
              .singleWhere((c) => c.method == MobileComposerMethods.setPlanMode)
              .params['planMode'],
          isTrue,
        );
        expect(tester.widget<TextField>(input).controller!.text, isEmpty);

        // 键入 /auto-accept -> 选中权限命令直接切换权限并清除文本。
        await tester.enterText(input, '/auto-accept');
        await tester.pumpAndSettle();
        await tester.tap(find.text('/auto-accept-edits'));
        await tester.pumpAndSettle();
        expect(
          host.calls
              .singleWhere(
                (c) => c.method == MobileComposerMethods.setPermissionMode,
              )
              .params['permissionMode'],
          'auto-accept-edits',
        );
        expect(tester.widget<TextField>(input).controller!.text, isEmpty);

        // 键入 /mod -> 选中 /model 打开模型底部弹层。
        await tester.enterText(input, '/mod');
        await tester.pumpAndSettle();
        await tester.tap(find.text('/model'));
        await tester.pumpAndSettle();
        expect(find.text('Agent 和模型'), findsOneWidget);
        await tester.tap(find.byTooltip('关闭弹层'));
        await tester.pumpAndSettle();

        // 键入 /comp -> 选中远程命令插入原生 `/compact ` 文本。
        await tester.enterText(input, '/comp');
        await tester.pumpAndSettle();
        await tester.tap(find.text('/compact'));
        await tester.pumpAndSettle();
        expect(tester.widget<TextField>(input).controller!.text, '/compact ');

        // 点击 + -> 使用 Skill，按名称搜索并插入 `$code-review `。
        await tester.tap(attach);
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(MobileComposerAttachButton.skillOptionKey));
        await tester.pumpAndSettle();
        expect(find.text('代码审查'), findsOneWidget);
        await tester.tap(find.text('代码审查'));
        await tester.pumpAndSettle();
        expect(
          tester.widget<TextField>(input).controller!.text,
          r'/compact $code-review ',
        );
      },
    );

    testWidgets(
      'ignores stale searchPaths responses when faster newer query finishes first',
      (tester) async {
        final slowFirst = Completer<MobileSearchPathsResult>();
        final fastSecond = Completer<MobileSearchPathsResult>();
        final host = _MentionHost(
          searchPathsHandler: (params) {
            final q = params['query'] as String;
            if (q == 'a') return slowFirst.future;
            if (q == 'ab') return fastSecond.future;
            return Future.value(
              const MobileSearchPathsResult(entries: [], truncated: false),
            );
          },
        );
        final connection = _MentionConnection(host);

        await tester.pumpWidget(
          ProviderScope(
            child: MaterialApp(
              theme: pigcodeTheme(Brightness.light),
              home: Scaffold(
                body: Align(
                  alignment: Alignment.bottomCenter,
                  child: RunComposer(
                    connection: connection,
                    threadId: 'thread-current',
                    projectId: 'proj-a',
                    online: true,
                    composer: host.composerState,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final input = find.byKey(const ValueKey('run-composer-input'));
        await tester.enterText(input, '@a');
        await tester.pump();
        await tester.enterText(input, '@ab');
        await tester.pump(const Duration(milliseconds: 150));

        // 较新的 @ab 先回来，较旧的 @a 后回来不得覆盖。
        fastSecond.complete(
          const MobileSearchPathsResult(
            entries: [
              MobilePathEntry(
                path: 'lib/ab.dart',
                kind: MobilePathEntryKind.file,
              ),
            ],
            truncated: false,
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('ab.dart'), findsOneWidget);

        slowFirst.complete(
          const MobileSearchPathsResult(
            entries: [
              MobilePathEntry(
                path: 'lib/stale.dart',
                kind: MobilePathEntryKind.file,
              ),
            ],
            truncated: false,
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('ab.dart'), findsOneWidget);
        expect(find.text('stale.dart'), findsNothing);
      },
    );

    testWidgets(
      'shows builtin slash commands immediately while remote agent.commands is still loading',
      (tester) async {
        final remoteCompleter = Completer<MobileAgentCommandsResult>();
        final host = _MentionHost(
          agentCommandsHandler: (_) => remoteCompleter.future,
        );
        final connection = _MentionConnection(host);

        await tester.pumpWidget(
          ProviderScope(
            child: MaterialApp(
              theme: pigcodeTheme(Brightness.light),
              home: Scaffold(
                body: Align(
                  alignment: Alignment.bottomCenter,
                  child: RunComposer(
                    connection: connection,
                    threadId: 'thread-current',
                    projectId: 'proj-a',
                    online: true,
                    composer: host.composerState,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.enterText(
          find.byKey(const ValueKey('run-composer-input')),
          '/',
        );
        await tester.pump();

        // 远程命令未返回前，内置命令与加载指示器立即出现。
        expect(find.text('/model'), findsOneWidget);
        expect(find.text('/plan'), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsOneWidget);

        remoteCompleter.complete(
          const MobileAgentCommandsResult(
            commands: _defaultAgentCommands,
            truncated: false,
          ),
        );
        await tester.pumpAndSettle();
        final scrollable = find.descendant(
          of: find.byKey(MobileComposerSuggestionPanel.panelKey),
          matching: find.byType(Scrollable),
        );
        await tester.scrollUntilVisible(
          find.text('/compact'),
          120,
          scrollable: scrollable,
        );
        expect(find.text('/compact'), findsOneWidget);
        expect(find.byType(CircularProgressIndicator), findsNothing);
      },
    );
  });

  group('NewThreadDraft mentions integration & legacy degradation', () {
    testWidgets(
      'supports @thread reference on NewThreadDraft and forwards references in thread.create',
      (tester) async {
        final host = _MentionHost();
        final connection = _MentionConnection(host);

        await tester.pumpWidget(
          ProviderScope(
            child: MaterialApp(
              theme: pigcodeTheme(Brightness.light),
              home: Scaffold(
                body: NewThreadDraft(
                  connection: connection,
                  projects: _projects,
                  threads: _threads,
                  projectId: 'proj-a',
                  online: true,
                  onAccepted: (_) {},
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        final input = find.byKey(const ValueKey('first-message-input'));
        await tester.enterText(input, '@');
        await tester.pumpAndSettle();

        // 确认 searchPaths 使用 projectId 而非 threadId。
        final searchCall = host.calls.lastWhere(
          (c) => c.method == MobileMentionMethods.searchPaths,
        );
        expect(searchCall.params['projectId'], 'proj-a');
        expect(searchCall.params.containsKey('threadId'), isFalse);

        await tester.tap(find.text('排查连接超时'));
        await tester.pumpAndSettle();

        await tester.tap(find.byTooltip('发送首条消息'));
        await tester.pumpAndSettle();

        final createCall = host.calls.lastWhere(
          (c) => c.method == MobileDraftMethods.create,
        );
        expect(createCall.params['text'], '@排查连接超时 ');
        expect(createCall.params['references'], [
          {'kind': 'thread', 'threadId': 'thread-1', 'title': '排查连接超时'},
        ]);
      },
    );

    testWidgets(
      'hides + button and sends zero mention RPCs on legacy computer (supportsComposerMentions == false)',
      (tester) async {
        final host = _MentionHost();
        final legacy = _MentionConnection(
          host,
          supportsComposerControls: false,
          supportsComposerMentions: false,
        );

        await tester.pumpWidget(
          ProviderScope(
            child: MaterialApp(
              theme: pigcodeTheme(Brightness.light),
              home: Scaffold(
                body: Align(
                  alignment: Alignment.bottomCenter,
                  child: RunComposer(
                    connection: legacy,
                    threadId: 'thread-legacy',
                    projectId: 'proj-a',
                    projects: _projects,
                    threads: _threads,
                    online: true,
                    composer: host.composerState,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.byKey(MobileComposerAttachButton.buttonKey), findsNothing);

        final input = find.byKey(const ValueKey('run-composer-input'));
        for (final text in ['@lib', '/model', r'$review']) {
          await tester.enterText(input, text);
          await tester.pump(const Duration(milliseconds: 160));
          expect(
            find.byKey(MobileComposerSuggestionPanel.panelKey),
            findsNothing,
          );
        }

        expect(
          host.calls.where(
            (c) =>
                c.method == MobileMentionMethods.searchPaths ||
                c.method == MobileMentionMethods.agentCommands,
          ),
          isEmpty,
        );

        await tester.tap(find.byTooltip('发送消息'));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      },
    );
  });

  group('360px narrow screen, touch targets & keyboard inset safety', () {
    for (final platform in const [TargetPlatform.iOS, TargetPlatform.android]) {
      testWidgets(
        'meets platform touch targets and zero overflow with keyboard open on 360px (${platform.name})',
        (tester) async {
          final minTouch = platform == TargetPlatform.android ? 48.0 : 44.0;
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = const Size(360, 740);
          tester.view.viewInsets = const FakeViewPadding(bottom: 260);
          addTearDown(tester.view.reset);

          final host = _MentionHost();
          final connection = _MentionConnection(host);

          await tester.pumpWidget(
            ProviderScope(
              child: MaterialApp(
                theme: pigcodeTheme(
                  Brightness.light,
                ).copyWith(platform: platform),
                home: Scaffold(
                  body: TimelinePane(
                    connection: connection,
                    threadId: 'thread-current',
                    projectId: 'proj-a',
                    projects: _projects,
                    threads: _threads,
                    online: true,
                    computerKey: connection.computer.computerKey,
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();

          final attach = find.byKey(MobileComposerAttachButton.buttonKey);
          expect(tester.getSize(attach).width, greaterThanOrEqualTo(minTouch));
          expect(tester.getSize(attach).height, greaterThanOrEqualTo(minTouch));

          await tester.enterText(
            find.byKey(const ValueKey('run-composer-input')),
            '@',
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);

          final close = find.byKey(
            MobileComposerSuggestionPanel.closeButtonKey,
          );
          expect(tester.getSize(close).width, greaterThanOrEqualTo(minTouch));
          expect(tester.getSize(close).height, greaterThanOrEqualTo(minTouch));

          final firstRow = find.byKey(
            const ValueKey('composer-suggestion-thread:thread-1'),
          );
          expect(
            tester.getSize(firstRow).height,
            greaterThanOrEqualTo(minTouch),
          );

          // 点关闭按钮可收起联想面板。
          await tester.tap(close);
          await tester.pumpAndSettle();
          expect(
            find.byKey(MobileComposerSuggestionPanel.panelKey),
            findsNothing,
          );
          expect(tester.takeException(), isNull);
        },
      );
    }
  });
}
