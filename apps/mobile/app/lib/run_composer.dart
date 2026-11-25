import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'composer/composer_catalog.dart';
import 'composer/composer_tokens.dart';
import 'composer/context_meter.dart';
import 'composer/mobile_composer_card.dart';
import 'composer/model_picker_sheet.dart';
import 'composer/model_preferences.dart';
import 'local_drafts.dart';
import 'message_queue_panel.dart';
import 'run_command_journal.dart';
import 'run_composer_state.dart';
import 'workspace_icon.dart';

class RunComposer extends ConsumerStatefulWidget {
  const RunComposer({
    super.key,
    required this.connection,
    required this.threadId,
    required this.online,
    this.stoppableRunId,
    this.queueRevision = 0,
    this.composer,
    this.wrapInput,
    this.draft,
    this.leading,
    this.trailing,
  });

  final MobileConnection connection;
  final String threadId;
  final bool online;
  final String? stoppableRunId;
  final int queueRevision;
  final MobileThreadComposerState? composer;
  final Widget Function(Widget)? wrapInput;
  final TextEditingController? draft;
  final Widget? leading;
  final Widget? trailing;

  @override
  ConsumerState<RunComposer> createState() => _RunComposerState();
}

class _RunComposerState extends ConsumerState<RunComposer> {
  final _localDraft = TextEditingController();
  final _selectionNotifier = ValueNotifier<ComposerSelectionSnapshot>(
    const ComposerSelectionSnapshot(),
  );
  MobileThreadComposerState? _composerOverride;
  String? _composerNotice;
  bool _updatingComposer = false;
  ComposerSelectionSnapshot _latestSelection =
      const ComposerSelectionSnapshot();

  TextEditingController get _draft => widget.draft ?? _localDraft;
  late final _draftStore = ThreadDraftStorage(
    widget.connection.computer.computerKey,
    widget.threadId,
  );

  MobileThreadComposerState? get _composer =>
      _composerOverride ?? widget.composer;

  @override
  void didUpdateWidget(covariant RunComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.threadId != widget.threadId ||
        !identical(oldWidget.connection, widget.connection)) {
      _composerOverride = null;
      _composerNotice = null;
      _updatingComposer = false;
    } else if (!identical(oldWidget.composer, widget.composer)) {
      _composerOverride = null;
    }
  }

  @override
  void dispose() {
    _localDraft.dispose();
    _selectionNotifier.dispose();
    super.dispose();
  }

  void _scheduleSelectionSync(ComposerSelectionSnapshot snapshot) {
    _latestSelection = snapshot;
    if (_selectionNotifier.value == snapshot) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _selectionNotifier.value != _latestSelection) {
        _selectionNotifier.value = _latestSelection;
      }
    });
  }

  String _composerErrorMessage(Object error) {
    if (error is MobileRpcFailure) {
      return error.problem.message;
    }
    return '暂时无法更新运行设置，请重试。';
  }

  Future<void> _mutateComposer(
    Future<MobileThreadComposerState> Function() request,
  ) async {
    if (!mounted || _updatingComposer || !widget.online) return;
    final connection = widget.connection;
    final threadId = widget.threadId;
    setState(() {
      _updatingComposer = true;
      _composerNotice = null;
    });
    _selectionNotifier.value = _buildSnapshotFromState(
      composer: _composer,
      busy: true,
      notice: null,
    );
    try {
      final updated = await request();
      if (!mounted ||
          widget.threadId != threadId ||
          !identical(widget.connection, connection)) {
        return;
      }
      setState(() {
        _composerOverride = updated;
        _composerNotice = null;
        _updatingComposer = false;
      });
      _selectionNotifier.value = _buildSnapshotFromState(
        composer: updated,
        busy: false,
        notice: null,
      );
    } catch (error) {
      if (!mounted ||
          widget.threadId != threadId ||
          !identical(widget.connection, connection)) {
        return;
      }
      final message = _composerErrorMessage(error);
      setState(() {
        _composerNotice = message;
        _updatingComposer = false;
      });
      _selectionNotifier.value = _buildSnapshotFromState(
        composer: _composer,
        busy: false,
        notice: message,
      );
    }
  }

  ComposerSelectionSnapshot _buildSnapshotFromState({
    required MobileThreadComposerState? composer,
    required bool busy,
    required String? notice,
  }) => ComposerSelectionSnapshot(
    instanceId: composer?.instanceId,
    agentId: composer?.agentId,
    modelId: composer?.modelId,
    permissionMode: composer?.permissionMode,
    planMode: composer?.planMode ?? false,
    supportsPlanMode: composer?.supportsPlanMode ?? false,
    locked: widget.stoppableRunId != null,
    notice: notice,
    busy: busy,
  );

  Future<void> _openModelPicker() async {
    if (!widget.online || !connectionSupportsComposerControls(widget.connection)) {
      return;
    }
    _selectionNotifier.value = _latestSelection;
    await showMobileModelPickerSheet(
      context: context,
      connection: widget.connection,
      selection: _selectionNotifier,
      onSelectModel: (instance, model) => _mutateComposer(
        () => widget.connection.composer.switchAgent(
          threadId: widget.threadId,
          instanceId: instance.instanceId,
          modelId: model.id,
        ),
      ),
      onPermissionMode: (mode) => _mutateComposer(
        () => widget.connection.composer.setPermissionMode(
          threadId: widget.threadId,
          permissionMode: mode,
        ),
      ),
      onPlanMode: (enabled) => _mutateComposer(
        () => widget.connection.composer.setPlanMode(
          threadId: widget.threadId,
          planMode: enabled,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final provider = runComposerProvider((widget.connection, widget.threadId));
    final commandState = ref.watch(provider);
    ref.listen(provider, (previous, next) {
      const method = MobileRunMethod.runStart;
      final outcome = next.value?.outcomes[method];
      if (outcome == null ||
          identical(outcome, previous?.value?.outcomes[method])) {
        return;
      }
      if (outcome.command case PendingSend(:final params)) {
        if (outcome.receipt != null && _draft.text == params.text) {
          _draft.clear();
        } else if (outcome.receipt == null && _draft.text.isEmpty) {
          _draft.text = params.text;
        }
      }
    });
    final controller = ref.read(provider.notifier);
    final supportsControls =
        widget.online && connectionSupportsComposerControls(widget.connection);
    final activeComposer = _composer;

    ResolvedComposerRunOptions runOptions = const ResolvedComposerRunOptions();
    Widget? effectiveTrailing = widget.trailing;

    if (supportsControls && activeComposer != null) {
      final preferences = ref.watch(modelPreferencesProvider);
      final optionsAsync = ref.watch(
        composerDraftOptionsProvider(widget.connection),
      );
      final instances =
          optionsAsync.value?.instances ?? const <MobileDraftInstance>[];
      final currentInstance = instances
          .where((item) => item.instanceId == activeComposer.instanceId)
          .firstOrNull;
      final modelsAsync = ref.watch(
        composerDraftModelsProvider((
          widget.connection,
          activeComposer.instanceId,
        )),
      );
      final currentModel = resolveDraftModel(
        modelsAsync.value,
        activeComposer.modelId,
      );
      runOptions = resolveComposerRunOptions(
        supportsComposerControls: true,
        instanceId: activeComposer.instanceId,
        model: currentModel,
        preferences: preferences,
      );
      _scheduleSelectionSync(
        _buildSnapshotFromState(
          composer: activeComposer,
          busy: _updatingComposer,
          notice: _composerNotice,
        ),
      );
      if (effectiveTrailing == null) {
        final instanceLabel =
            currentInstance?.label ?? activeComposer.agentId;
        final modelLabel =
            currentModel?.label ??
            activeComposer.modelId ??
            currentInstance?.label ??
            '选择模型';
        effectiveTrailing = Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            MobileModelPickerChip(
              agentId: currentInstance?.agentId ?? activeComposer.agentId,
              instanceId: activeComposer.instanceId,
              accentColor: currentInstance?.accentColor,
              instanceLabel: instanceLabel,
              modelLabel: modelLabel,
              effort: runOptions.effort,
              fast: runOptions.fast == true,
              ultracode: runOptions.ultracode == true,
              planMode: activeComposer.planMode,
              permissionMode: activeComposer.permissionMode,
              defaultPermissionMode: currentInstance?.defaultPermissionMode,
              onTap: _openModelPicker,
            ),
            if (activeComposer.contextUsage case final usage?)
              MobileContextMeter(usage: usage),
          ],
        );
      }
    }

    final extraBanners = <Widget>[
      if (_composerNotice case final notice? when notice.isNotEmpty)
        _ComposerInlineNotice(
          text: notice,
          onDismiss: () => setState(() => _composerNotice = null),
        ),
    ];

    final view = RunComposerView(
      draft: _draft,
      online: widget.online,
      stoppableRunId: widget.stoppableRunId,
      allowQueue: widget.connection.supportsQueueCommands,
      state: commandState.value,
      storageError: commandState.hasError,
      onRetryLoad: () => ref.invalidate(provider),
      onSend: (text) => controller.send(
        text,
        effort: runOptions.effort,
        fast: runOptions.fast,
        ultracode: runOptions.ultracode,
      ),
      onStop: controller.stop,
      onCheck: controller.check,
      onRetry: controller.retry,
      extraBanners: extraBanners,
      leading: widget.leading,
      trailing: effectiveTrailing,
    );
    final input = widget.wrapInput?.call(view) ?? view;
    if (!widget.connection.supportsQueueCommands) return input;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        MessageQueuePanel(
          connection: widget.connection,
          threadId: widget.threadId,
          revision: widget.queueRevision,
          online: widget.online,
          onWithdraw: _restoreWithdrawal,
          onWithdrawalAcknowledged: _draftStore.finishWithdrawal,
        ),
        input,
      ],
    );
  }

  Future<void> _restoreWithdrawal(QueueReceipt receipt) async {
    final controller = _draft;
    final original = controller.text;
    final text = receipt.text!;
    final restored = await _draftStore.restoreWithdrawal(
      receipt.commandId,
      text,
      fallback: original,
    );
    if (!mounted || !identical(controller, _draft)) return;
    final current = controller.text;
    if (!restored.appended && current != original) return;
    final next = current == original
        ? restored.text
        : current.isEmpty
        ? text
        : '$current\n$text';
    controller.value = TextEditingValue(
      text: next,
      selection: TextSelection.collapsed(offset: next.length),
    );
    if (next != restored.text) await _draftStore.save(next, previous: current);
  }
}

class _ComposerInlineNotice extends StatelessWidget {
  const _ComposerInlineNotice({required this.text, required this.onDismiss});

  final String text;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final colors = ComposerSurface.palette(Theme.of(context).brightness);
    return Semantics(
      liveRegion: true,
      child: Row(
        spacing: ComposerSpace.chipGap,
        children: [
          Expanded(
            child: Text(text, style: ComposerType.notice(colors.error)),
          ),
          TextButton(onPressed: onDismiss, child: const Text('知道了')),
        ],
      ),
    );
  }
}

class RunComposerView extends StatelessWidget {
  const RunComposerView({
    super.key,
    required this.draft,
    required this.online,
    required this.state,
    required this.storageError,
    required this.onRetryLoad,
    required this.onSend,
    required this.onStop,
    required this.onCheck,
    required this.onRetry,
    this.stoppableRunId,
    this.allowQueue = false,
    this.extraBanners = const [],
    this.leading,
    this.trailing,
  });

  final TextEditingController draft;
  final bool online;
  final String? stoppableRunId;
  final bool allowQueue;
  final RunComposerState? state;
  final bool storageError;
  final VoidCallback onRetryLoad;
  final ValueChanged<String> onSend;
  final ValueChanged<String> onStop;
  final ValueChanged<MobileRunMethod> onCheck;
  final ValueChanged<MobileRunMethod> onRetry;
  final List<Widget> extraBanners;
  final Widget? leading;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final runId = stoppableRunId;

    bool enabled(MobileRunMethod method) =>
        online &&
        state != null &&
        !state!.working.contains(method) &&
        !state!.pending.containsKey(method);

    final statusBanners = <Widget>[
      ...extraBanners,
      if (storageError)
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            const Text('无法读取发送状态。'),
            TextButton(onPressed: onRetryLoad, child: const Text('重试读取')),
          ],
        ),
      if (state case final view?)
        for (final kind in MobileRunMethod.values)
          if (view.pending[kind] != null ||
              view.notices[kind] != null ||
              view.outcomes[kind]?.recovered == true)
            _PendingRunRow(
              kind: kind,
              draft: draft,
              state: view,
              online: online,
              onCheck: () => onCheck(kind),
              onRetry: () => onRetry(kind),
            ),
    ];

    final hintText = !online
        ? '电脑离线，消息发不出去'
        : runId != null && allowQueue
        ? '生成中 · 发出的消息会排队'
        : '回复…';

    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: draft,
      builder: (context, value, _) {
        final text = value.text;
        final hasText = text.trim().isNotEmpty;
        final tooLong = text.length > mobileCommandTextLimit;
        final canSend = enabled(MobileRunMethod.runStart) && hasText && !tooLong;
        final banners = <Widget>[
          ...statusBanners,
          if (tooLong)
            Text(
              '每条消息最多 $mobileCommandTextLimit 个字符。',
              style: theme.textTheme.bodySmall,
            ),
        ];
        final actions = <Widget>[
          if (runId != null)
            MobileComposerActionButton(
              tooltip: '停止本轮运行',
              glyph: WorkspaceGlyph.stop,
              offline: !online,
              onPressed: enabled(MobileRunMethod.runInterrupt)
                  ? () => onStop(runId)
                  : null,
            ),
          if (runId == null || (allowQueue && hasText))
            MobileComposerActionButton(
              tooltip: '发送消息',
              glyph: WorkspaceGlyph.arrowUp,
              offline: !online,
              onPressed: canSend ? () => onSend(text) : null,
            ),
        ];
        return MobileComposerCard(
          controller: draft,
          inputKey: const ValueKey('run-composer-input'),
          hintText: hintText,
          offline: !online,
          banners: banners,
          leading: leading,
          trailing: trailing,
          actions: actions,
        );
      },
    );
  }
}

class _PendingRunRow extends StatelessWidget {
  const _PendingRunRow({
    required this.kind,
    required this.draft,
    required this.state,
    required this.online,
    required this.onCheck,
    required this.onRetry,
  });

  final MobileRunMethod kind;
  final TextEditingController draft;
  final RunComposerState state;
  final bool online;
  final VoidCallback onCheck;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final pending = state.pending[kind];
    final outcome = state.outcomes[kind];
    final recovered = outcome?.recovered == true ? outcome!.receipt : null;
    final working = state.working.contains(kind);
    final label = switch (kind) {
      MobileRunMethod.runStart => working ? '正在确认发送…' : '发送结果待确认',
      MobileRunMethod.runInterrupt => working ? '正在确认停止…' : '停止结果待确认',
    };
    final text = recovered != null
        ? switch (kind) {
            MobileRunMethod.runStart =>
              recovered.queuedMessageId == null ? '已找回发送回执' : '已找回待发回执',
            MobileRunMethod.runInterrupt => '已找回停止回执',
          }
        : state.notices[kind] ?? label;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          liveRegion: true,
          child: Text(text, style: Theme.of(context).textTheme.bodySmall),
        ),
        if (recovered != null)
          SelectableText(
            recovered.queuedMessageId ?? recovered.runId,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        if (pending case PendingSend(:final params))
          Text(
            params.text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: Theme.of(context).textTheme.bodySmall,
          ),
        if (pending != null && !working)
          Wrap(
            children: [
              TextButton(
                onPressed: online ? onCheck : null,
                child: const Text('查回执'),
              ),
              TextButton(
                onPressed: online ? onRetry : null,
                child: const Text('用原编号重试'),
              ),
            ],
          ),
        if (outcome case RunCommandOutcome(
          receipt: null,
          command: PendingSend(:final params),
        ))
          ValueListenableBuilder<TextEditingValue>(
            valueListenable: draft,
            builder: (context, value, _) => value.text == params.text
                ? const SizedBox.shrink()
                : TextButton(
                    onPressed: () =>
                        Clipboard.setData(ClipboardData(text: params.text)),
                    child: const Text('复制原文'),
                  ),
          ),
      ],
    );
  }
}
