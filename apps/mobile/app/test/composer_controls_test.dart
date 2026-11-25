import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:pigcode_client/host_rpc.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_mobile/app_theme.dart';
import 'package:pigcode_mobile/composer/model_picker_sheet.dart';
import 'package:pigcode_mobile/new_thread_draft.dart';
import 'package:pigcode_mobile/run_composer.dart';
import 'package:pigcode_mobile/timeline_pane.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

const _projects = [
  MobileProjectSummary(id: 'proj-1', name: '核心仓库'),
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

const _codexInstance = MobileDraftInstance(
  instanceId: 'codex',
  agentId: 'codex',
  label: 'Codex',
  agentName: 'Codex',
  accentColor: '#5279bf',
  supportsPlanMode: false,
  permissionModes: [
    MobileDraftPermission.approvalRequired,
    MobileDraftPermission.autoAcceptEdits,
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
      efforts: ['low', 'medium', 'high', 'max'],
      fast: true,
      ultracode: true,
    ),
    MobileDraftModel(
      id: 'haiku',
      label: 'Claude Haiku 4.5',
      efforts: [],
      fast: false,
      ultracode: false,
    ),
  ],
);

const _codexModels = MobileDraftModels(
  defaultModelId: 'gpt-5.4',
  models: [
    MobileDraftModel(
      id: 'gpt-5.4',
      label: 'GPT-5.4 Codex',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      fast: true,
      ultracode: false,
    ),
  ],
);

class _ControlsHost implements HostRequests {
  _ControlsHost({
    MobileThreadComposerState? initialComposer,
    this.rejectSwitchAgent = false,
  }) : composerState =
           initialComposer ??
           const MobileThreadComposerState(
             instanceId: 'claude',
             agentId: 'claude',
             modelId: 'opus',
             permissionMode: MobileDraftPermission.approvalRequired,
             planMode: false,
             supportsPlanMode: true,
             contextUsage: MobileContextUsage(
               usedTokens: 86000,
               maxTokens: 200000,
               autoCompactTokens: 100000,
             ),
           );

  final calls = <({String method, Map<String, Object?> params})>[];
  final loadedModelInstances = <String>[];
  final _notifications = StreamController<Map<String, dynamic>>.broadcast();
  MobileThreadComposerState composerState;
  bool rejectSwitchAgent;

  void dispose() => unawaited(_notifications.close());

  @override
  Stream<Map<String, dynamic>> get notifications => _notifications.stream;

  @override
  Future<Object?> call(String method, Map<String, Object?> params) async {
    calls.add((method: method, params: params));
    switch (method) {
      case MobileDraftMethods.options:
        return const MobileDraftOptions(
          defaultInstanceId: 'claude',
          instances: [_claudeInstance, _codexInstance],
        ).toJson();
      case MobileDraftMethods.models:
        final instanceId = params['instanceId'] as String;
        loadedModelInstances.add(instanceId);
        return (instanceId == 'codex' ? _codexModels : _claudeModels).toJson();
      case MobileDraftMethods.create:
        return MobileDraftReceipt(
          method: MobileDraftMethods.create,
          commandId: params['commandId'] as String,
          projectId: params['projectId'] as String,
          threadId: 'created-thread',
          title: params['text'] as String,
          runId: 'run-1',
        ).toJson();
      case MobileComposerMethods.switchAgent:
        if (rejectSwitchAgent) {
          throw const MobileRpcFailure(
            MobileRpcProblem(
              code: 'THREAD_BUSY',
              message: '当前会话正在运行，暂时无法切换模型。',
              retryable: false,
            ),
          );
        }
        final instanceId = params['instanceId'] as String;
        final isCodex = instanceId == 'codex';
        composerState = MobileThreadComposerState(
          instanceId: instanceId,
          agentId: isCodex ? 'codex' : 'claude',
          modelId: params['modelId'] as String?,
          permissionMode: composerState.permissionMode,
          planMode: isCodex ? false : composerState.planMode,
          supportsPlanMode: !isCodex,
          contextUsage: composerState.contextUsage,
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
          contextUsage: composerState.contextUsage,
        );
        return composerState.toJson();
      case MobileComposerMethods.setPlanMode:
        composerState = MobileThreadComposerState(
          instanceId: composerState.instanceId,
          agentId: composerState.agentId,
          modelId: composerState.modelId,
          permissionMode: composerState.permissionMode,
          planMode: params['planMode'] as bool,
          supportsPlanMode: composerState.supportsPlanMode,
          contextUsage: composerState.contextUsage,
        );
        return composerState.toJson();
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
      default:
        throw StateError('Unexpected RPC method: $method');
    }
  }
}

class _ControlsTimeline implements MobileTimeline {
  _ControlsTimeline(this.snapshot);

  @override
  final TimelineSnapshot snapshot;

  @override
  Stream<TimelineSnapshot> get updates => const Stream.empty();

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _ControlsConnection implements MobileConnection {
  _ControlsConnection(
    this.host, {
    this.supportsComposerControls = true,
  }) : drafts = MobileDraftCommands(host),
       composer = MobileComposerCommands(host),
       runCommands = MobileRunCommands(host),
       queue = MobileQueueCommands(host);

  final _ControlsHost host;

  @override
  final bool supportsComposerControls;
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
  final MobileRunCommands runCommands;
  @override
  final MobileQueueCommands queue;
  @override
  final computer = ComputerProfile(
    address: 'wss://localhost/ws/v1/connect',
    token: 'fixture',
    computerKey: base64Url.encode(List<int>.filled(32, 5)).replaceAll('=', ''),
    name: '开发电脑',
  );
  @override
  String get deviceId => 'phone-1';

  @override
  Future<MobileTimeline> openTimeline(
    String threadId, {
    TimelineSnapshot? resumeFrom,
  }) async => _ControlsTimeline(
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

Future<void> _tapEffortStop(
  WidgetTester tester, {
  required int index,
  required int maxIndex,
}) async {
  final slider = find.byKey(const ValueKey('composer-effort-slider'));
  final rect = tester.getRect(slider);
  const thumb = 18.0;
  final x = rect.left + thumb / 2 + (rect.width - thumb) * (index / maxIndex);
  await tester.tapAt(Offset(x, rect.center.dy));
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => FlutterSecureStorage.setMockInitialValues({}));

  group('Existing thread composer controls & TimelinePane integration', () {
    testWidgets(
      'displays composite chip and context meter, supports rail/favorites/search/model switch without closing, effort, fast, ultracode, plan mode, and full-access confirmation',
      (tester) async {
        final host = _ControlsHost();
        addTearDown(host.dispose);
        final connection = _ControlsConnection(host);

        await tester.pumpWidget(
          ProviderScope(
            child: MaterialApp(
              theme: pigcodeTheme(
                Brightness.light,
              ).copyWith(platform: TargetPlatform.iOS),
              home: Scaffold(
                body: TimelinePane(
                  connection: connection,
                  threadId: 'thread-1',
                  online: true,
                  computerKey: connection.computer.computerKey,
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        // 综合模型胶囊与上下文占用圆环均已展示。
        final chip = find.byKey(MobileModelPickerChip.chipKey);
        expect(chip, findsOneWidget);
        expect(find.text('Claude Opus 4.6'), findsOneWidget);
        expect(find.byTooltip('上下文占用'), findsOneWidget);
        // 挂载时只懒加载了当前实例的模型目录，未预加载 codex。
        expect(host.loadedModelInstances, ['claude']);

        // 点按上下文圆环打开详情弹层。
        await tester.tap(find.byTooltip('上下文占用'));
        await tester.pumpAndSettle();
        expect(find.text('上下文占用'), findsOneWidget);
        expect(find.text('已用 86k / 200k（43%）'), findsOneWidget);
        expect(find.text('到 100k 自动压缩，还剩 14k'), findsOneWidget);
        await tester.tap(find.byTooltip('关闭弹层'));
        await tester.pumpAndSettle();

        // 点击模型胶囊打开底部弹层。
        await tester.tap(chip);
        await tester.pumpAndSettle();
        expect(find.text('Agent 和模型'), findsOneWidget);

        // 搜索过滤（匹配 id/label）。
        await tester.enterText(
          find.byKey(const ValueKey('composer-model-search')),
          'hai',
        );
        await tester.pumpAndSettle();
        expect(find.text('Claude Haiku 4.5'), findsOneWidget);
        expect(
          find.descendant(
            of: find.byType(ListView),
            matching: find.text('Claude Opus 4.6'),
          ),
          findsNothing,
        );
        await tester.tap(find.byTooltip('清除搜索'));
        await tester.pumpAndSettle();

        // 切换到 Codex 页签 -> 按需懒加载 codex 模型目录并收藏。
        await tester.tap(find.byKey(const ValueKey('composer-rail-codex')));
        await tester.pumpAndSettle();
        expect(host.loadedModelInstances, ['claude', 'codex']);
        expect(find.text('GPT-5.4 Codex'), findsOneWidget);

        await tester.tap(
          find.byKey(const ValueKey('composer-favorite-codex-gpt-5.4')),
        );
        await tester.pumpAndSettle();

        // 切换到收藏星标页 -> 可见已收藏模型。
        await tester.tap(find.byKey(const ValueKey('composer-rail-favorites')));
        await tester.pumpAndSettle();
        expect(find.text('GPT-5.4 Codex'), findsOneWidget);

        // 切回 Claude 页签并先调整思考深度、快速模式、Ultracode、计划模式。
        await tester.tap(find.byKey(const ValueKey('composer-rail-claude')));
        await tester.pumpAndSettle();

        // 思考深度：stops = [默认, 低, 中, 高, 最高]，选 index 3 -> 「高」。
        await _tapEffortStop(tester, index: 3, maxIndex: 4);
        expect(
          tester.widget<Text>(find.byKey(const ValueKey('composer-effort-value'))).data,
          '高',
        );

        // 开启快速模式与 Ultracode。
        await tester.tap(find.byKey(const ValueKey('composer-switch-fast')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('composer-switch-ultracode')),
        );
        await tester.pumpAndSettle();

        // 开启计划模式 -> 调用 thread.setPlanMode。
        await tester.tap(find.byKey(const ValueKey('composer-plan-toggle')));
        await tester.pumpAndSettle();
        expect(
          host.calls.where((c) => c.method == MobileComposerMethods.setPlanMode),
          hasLength(1),
        );
        expect(
          host.calls
              .lastWhere((c) => c.method == MobileComposerMethods.setPlanMode)
              .params['planMode'],
          isTrue,
        );

        // 切换权限到「完全访问」：先取消，权限不变。
        await tester.tap(
          find.byKey(const ValueKey('composer-permission-button')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('完全访问'));
        await tester.pumpAndSettle();
        expect(find.text('打开完全访问？'), findsOneWidget);
        await tester.tap(find.text('取消'));
        await tester.pumpAndSettle();
        expect(
          host.calls.where(
            (c) => c.method == MobileComposerMethods.setPermissionMode,
          ),
          isEmpty,
        );

        // 再次选择「完全访问」并确认 -> 调用 thread.setPermissionMode。
        await tester.tap(
          find.byKey(const ValueKey('composer-permission-button')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('完全访问'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('打开完全访问'));
        await tester.pumpAndSettle();
        expect(
          host.calls
              .singleWhere(
                (c) => c.method == MobileComposerMethods.setPermissionMode,
              )
              .params['permissionMode'],
          'full-access',
        );

        // 在同一弹层中点选另一个模型（Haiku）：弹层不关闭，且底部思考深度变为置灰「—」。
        await tester.tap(find.text('Claude Haiku 4.5'));
        await tester.pumpAndSettle();
        expect(find.text('Agent 和模型'), findsOneWidget);
        expect(
          host.calls
              .lastWhere((c) => c.method == MobileComposerMethods.switchAgent)
              .params,
          containsPair('modelId', 'haiku'),
        );
        expect(
          tester.widget<Text>(find.byKey(const ValueKey('composer-effort-value'))).data,
          '—',
        );

        // 切回 Opus（支持 effort/fast/ultracode），关闭弹层并发送消息验证透传。
        await tester.tap(find.text('Claude Opus 4.6'));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('关闭弹层'));
        await tester.pumpAndSettle();

        // 胶囊展示非默认思考深度、计划短标记。
        expect(
          find.descendant(of: chip, matching: find.text('高')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: chip, matching: find.text('计划')),
          findsOneWidget,
        );

        await tester.enterText(
          find.byKey(const ValueKey('run-composer-input')),
          '请用高思考深度执行',
        );
        await tester.pump();
        await tester.tap(find.byTooltip('发送消息'));
        await tester.pumpAndSettle();

        final startCall = host.calls.lastWhere(
          (c) => c.method == MobileCommandMethods.start,
        );
        expect(startCall.params['effort'], 'high');
        expect(startCall.params['fast'], isTrue);
        expect(startCall.params['ultracode'], isTrue);
      },
    );

    testWidgets(
      'locks agent/model switching while running while still allowing effort, switches, plan mode, and permission adjustments for next send',
      (tester) async {
        final host = _ControlsHost();
        addTearDown(host.dispose);
        final connection = _ControlsConnection(host);

        await tester.pumpWidget(
          ProviderScope(
            child: MaterialApp(
              theme: pigcodeTheme(Brightness.light),
              home: Scaffold(
                body: Align(
                  alignment: Alignment.bottomCenter,
                  child: RunComposer(
                    connection: connection,
                    threadId: 'thread-running',
                    online: true,
                    stoppableRunId: 'active-run-1',
                    composer: host.composerState,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(MobileModelPickerChip.chipKey));
        await tester.pumpAndSettle();

        // 显示运行中锁定提示。
        expect(
          find.byKey(const ValueKey('composer-model-locked-banner')),
          findsOneWidget,
        );
        expect(
          find.text('运行中不可切换 Agent 或模型，其他参数将在下一轮生效'),
          findsOneWidget,
        );

        // 点击模型行被锁定，不会触发 switchAgent。
        await tester.tap(find.text('Claude Haiku 4.5'));
        await tester.pumpAndSettle();
        expect(
          host.calls.where((c) => c.method == MobileComposerMethods.switchAgent),
          isEmpty,
        );

        // 但思考深度、快速模式、Ultracode、计划模式与权限模式均可正常修改。
        await _tapEffortStop(tester, index: 4, maxIndex: 4); // 最高
        await tester.tap(find.byKey(const ValueKey('composer-switch-fast')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('composer-switch-ultracode')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-plan-toggle')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('composer-permission-button')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('接受编辑'));
        await tester.pumpAndSettle();

        expect(
          host.calls
              .singleWhere((c) => c.method == MobileComposerMethods.setPlanMode)
              .params['planMode'],
          isTrue,
        );
        expect(
          host.calls
              .singleWhere(
                (c) => c.method == MobileComposerMethods.setPermissionMode,
              )
              .params['permissionMode'],
          'auto-accept-edits',
        );

        await tester.tap(find.byTooltip('关闭弹层'));
        await tester.pumpAndSettle();

        // 发送下一条（排队）消息时携带刚刚调整的 effort/fast/ultracode。
        await tester.enterText(
          find.byKey(const ValueKey('run-composer-input')),
          '下一轮请用最高深度',
        );
        await tester.pump();
        await tester.tap(find.byTooltip('发送消息'));
        await tester.pumpAndSettle();

        final startCall = host.calls.lastWhere(
          (c) => c.method == MobileCommandMethods.start,
        );
        expect(startCall.params['effort'], 'max');
        expect(startCall.params['fast'], isTrue);
        expect(startCall.params['ultracode'], isTrue);
      },
    );

    testWidgets('shows gentle inline notice when switchAgent RPC fails without crashing', (
      tester,
    ) async {
      final host = _ControlsHost(rejectSwitchAgent: true);
      addTearDown(host.dispose);
      final connection = _ControlsConnection(host);

      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            theme: pigcodeTheme(Brightness.light),
            home: Scaffold(
              body: Align(
                alignment: Alignment.bottomCenter,
                child: RunComposer(
                  connection: connection,
                  threadId: 'thread-busy',
                  online: true,
                  composer: host.composerState,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(MobileModelPickerChip.chipKey));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Claude Haiku 4.5'));
      await tester.pumpAndSettle();

      expect(find.text('当前会话正在运行，暂时无法切换模型。'), findsWidgets);
      expect(tester.takeException(), isNull);
    });

    testWidgets('gracefully degrades for legacy computers without composer controls', (
      tester,
    ) async {
      final host = _ControlsHost();
      addTearDown(host.dispose);
      final legacy = _ControlsConnection(
        host,
        supportsComposerControls: false,
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
                  online: true,
                  composer: host.composerState,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(MobileModelPickerChip.chipKey), findsNothing);
      expect(find.byTooltip('上下文占用'), findsNothing);
      expect(host.loadedModelInstances, isEmpty);

      await tester.enterText(
        find.byKey(const ValueKey('run-composer-input')),
        '发给旧版电脑',
      );
      await tester.pump();
      await tester.tap(find.byTooltip('发送消息'));
      await tester.pumpAndSettle();

      final startCall = host.calls.lastWhere(
        (c) => c.method == MobileCommandMethods.start,
      );
      expect(startCall.params.containsKey('effort'), isFalse);
      expect(startCall.params.containsKey('fast'), isFalse);
      expect(startCall.params.containsKey('ultracode'), isFalse);
      expect(startCall.params.containsKey('references'), isFalse);
    });
  });

  group('NewThreadDraft composer controls & persistence', () {
    testWidgets(
      'uses composite model picker, persists planMode & preferences across rebuild, resets planMode on non-plan instance, and forwards all params on thread.create',
      (tester) async {
        final host = _ControlsHost();
        addTearDown(host.dispose);
        final connection = _ControlsConnection(host);

        Widget buildDraft() => ProviderScope(
          child: MaterialApp(
            theme: pigcodeTheme(Brightness.light),
            home: Scaffold(
              body: NewThreadDraft(
                connection: connection,
                projects: _projects,
                projectId: 'proj-1',
                online: true,
                onAccepted: (_) {},
              ),
            ),
          ),
        );

        await tester.pumpWidget(buildDraft());
        await tester.pumpAndSettle();

        // 保留顶部项目条，底栏使用综合模型胶囊而非旧版三胶囊。
        expect(find.byTooltip('草稿项目'), findsOneWidget);
        expect(find.byKey(MobileModelPickerChip.chipKey), findsOneWidget);
        expect(find.byTooltip('草稿 Agent 实例'), findsNothing);

        await tester.tap(find.byKey(MobileModelPickerChip.chipKey));
        await tester.pumpAndSettle();

        // 在 Claude 下开启计划模式、思考深度高、快速模式、Ultracode。
        await _tapEffortStop(tester, index: 3, maxIndex: 4); // 高
        await tester.tap(find.byKey(const ValueKey('composer-switch-fast')));
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const ValueKey('composer-switch-ultracode')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-plan-toggle')));
        await tester.pumpAndSettle();

        // 切换到不支持计划模式的 Codex 实例 -> planMode 自动重置且计划模式按钮隐藏。
        await tester.tap(find.byKey(const ValueKey('composer-rail-codex')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('GPT-5.4 Codex'));
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('composer-plan-toggle')), findsNothing);

        // 切回 Claude Opus 并再次开启计划模式，然后重建 ProviderScope 验证持久化。
        await tester.tap(find.byKey(const ValueKey('composer-rail-claude')));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Claude Opus 4.6'));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const ValueKey('composer-plan-toggle')));
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('关闭弹层'));
        await tester.pumpAndSettle();

        // 模拟重启重建 ProviderScope。
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
        await tester.pumpWidget(buildDraft());
        await tester.pumpAndSettle();

        final chip = find.byKey(MobileModelPickerChip.chipKey);
        expect(
          find.descendant(of: chip, matching: find.text('高')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: chip, matching: find.text('计划')),
          findsOneWidget,
        );

        await tester.enterText(
          find.byKey(const ValueKey('first-message-input')),
          '新建一个带计划模式的会话',
        );
        await tester.pump();
        await tester.tap(find.byTooltip('发送首条消息'));
        await tester.pumpAndSettle();

        final createCall = host.calls.lastWhere(
          (c) => c.method == MobileDraftMethods.create,
        );
        expect(createCall.params['effort'], 'high');
        expect(createCall.params['fast'], isTrue);
        expect(createCall.params['ultracode'], isTrue);
        expect(createCall.params['planMode'], isTrue);
      },
    );

    testWidgets('legacy computer on NewThreadDraft degrades without sending extended fields', (
      tester,
    ) async {
      final host = _ControlsHost();
      addTearDown(host.dispose);
      final legacy = _ControlsConnection(host, supportsComposerControls: false);

      await tester.pumpWidget(
        ProviderScope(
          child: MaterialApp(
            theme: pigcodeTheme(Brightness.light),
            home: Scaffold(
              body: NewThreadDraft(
                connection: legacy,
                projects: _projects,
                projectId: 'proj-1',
                online: true,
                onAccepted: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(MobileModelPickerChip.chipKey), findsNothing);
      expect(find.byTooltip('草稿 Agent 实例'), findsOneWidget);

      await tester.enterText(
        find.byKey(const ValueKey('first-message-input')),
        '旧版电脑新建会话',
      );
      await tester.pump();
      await tester.tap(find.byTooltip('发送首条消息'));
      await tester.pumpAndSettle();

      final createCall = host.calls.lastWhere(
        (c) => c.method == MobileDraftMethods.create,
      );
      expect(createCall.params.containsKey('effort'), isFalse);
      expect(createCall.params.containsKey('fast'), isFalse);
      expect(createCall.params.containsKey('ultracode'), isFalse);
      expect(createCall.params.containsKey('planMode'), isFalse);
    });
  });

  group('360px narrow screen touch targets and zero overflow', () {
    for (final platform in const [TargetPlatform.iOS, TargetPlatform.android]) {
      testWidgets(
        'enforces >= ${platform == TargetPlatform.android ? 48 : 44}px touch targets with zero overflow across composer and sheet (${platform.name})',
        (tester) async {
          final minTouch = platform == TargetPlatform.android ? 48.0 : 44.0;
          tester.view.devicePixelRatio = 1;
          tester.view.physicalSize = const Size(360, 740);
          addTearDown(tester.view.reset);

          final host = _ControlsHost(
            initialComposer: const MobileThreadComposerState(
              instanceId: 'claude',
              agentId: 'claude',
              modelId: 'opus',
              permissionMode: MobileDraftPermission.fullAccess,
              planMode: true,
              supportsPlanMode: true,
              contextUsage: MobileContextUsage(
                usedTokens: 96000,
                maxTokens: 200000,
                autoCompactTokens: 100000,
              ),
            ),
          );
          addTearDown(host.dispose);
          final connection = _ControlsConnection(host);

          await tester.pumpWidget(
            ProviderScope(
              child: MaterialApp(
                theme: pigcodeTheme(Brightness.dark).copyWith(
                  platform: platform,
                ),
                home: Scaffold(
                  body: Align(
                    alignment: Alignment.bottomCenter,
                    child: RunComposer(
                      connection: connection,
                      threadId: 'narrow-thread',
                      online: true,
                      stoppableRunId: 'run-narrow',
                      composer: host.composerState,
                    ),
                  ),
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);

          // 验证底栏控件触区尺寸。
          final chip = find.byKey(MobileModelPickerChip.chipKey);
          final meter = find.byTooltip('上下文占用');
          for (final target in [chip, meter]) {
            final size = tester.getSize(target);
            expect(size.width, greaterThanOrEqualTo(minTouch));
            expect(size.height, greaterThanOrEqualTo(minTouch));
          }

          // 打开底部弹层，验证窄屏零溢出与内部全部可点控件触区。
          await tester.tap(chip);
          await tester.pumpAndSettle();
          expect(tester.takeException(), isNull);

          for (final target in [
            find.byTooltip('关闭弹层'),
            find.byKey(const ValueKey('composer-rail-favorites')),
            find.byKey(const ValueKey('composer-rail-claude')),
            find.byKey(const ValueKey('composer-rail-codex')),
            find.byKey(const ValueKey('composer-favorite-claude-opus')),
            find.byKey(const ValueKey('composer-effort-slider')),
            find.byKey(const ValueKey('composer-switch-fast')),
            find.byKey(const ValueKey('composer-switch-ultracode')),
            find.byKey(const ValueKey('composer-plan-toggle')),
            find.byKey(const ValueKey('composer-permission-button')),
          ]) {
            final size = tester.getSize(target);
            expect(size.height, greaterThanOrEqualTo(minTouch));
            expect(size.width, greaterThanOrEqualTo(minTouch));
          }
        },
      );
    }
  });
}
