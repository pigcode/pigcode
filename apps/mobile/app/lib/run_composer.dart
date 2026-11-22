import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'message_queue_panel.dart';
import 'run_command_journal.dart';
import 'run_composer_state.dart';
import 'theme_colors.dart';

class RunComposer extends ConsumerStatefulWidget {
  const RunComposer({
    super.key,
    required this.connection,
    required this.threadId,
    required this.online,
    this.stoppableRunId,
    this.queueRevision = 0,
    this.wrapInput,
  });

  final MobileConnection connection;
  final String threadId;
  final bool online;
  final String? stoppableRunId;
  final int queueRevision;
  final Widget Function(Widget)? wrapInput;

  @override
  ConsumerState<RunComposer> createState() => _RunComposerState();
}

class _RunComposerState extends ConsumerState<RunComposer> {
  final _draft = TextEditingController();

  @override
  void dispose() {
    _draft.dispose();
    super.dispose();
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
    final view = RunComposerView(
      draft: _draft,
      online: widget.online,
      stoppableRunId: widget.stoppableRunId,
      allowQueue: widget.connection.supportsQueueCommands,
      state: commandState.value,
      storageError: commandState.hasError,
      onRetryLoad: () => ref.invalidate(provider),
      onSend: controller.send,
      onStop: controller.stop,
      onCheck: controller.check,
      onRetry: controller.retry,
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
          onWithdraw: (text) {
            final original = _draft.text;
            final restored = original.isEmpty ? text : '$original\n$text';
            _draft.value = TextEditingValue(
              text: restored,
              selection: TextSelection.collapsed(offset: restored.length),
            );
          },
        ),
        input,
      ],
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

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final hit = theme.platform == TargetPlatform.android ? 48.0 : 44.0;
    final runId = stoppableRunId;

    bool enabled(MobileRunMethod method) =>
        online &&
        state != null &&
        !state!.working.contains(method) &&
        !state!.pending.containsKey(method);

    Widget action(String label, IconData icon, VoidCallback? onPressed) =>
        SizedBox.square(
          dimension: hit,
          child: IconButton(
            onPressed: onPressed,
            tooltip: label,
            padding: EdgeInsets.zero,
            icon: DecoratedBox(
              decoration: BoxDecoration(
                color: onPressed != null ? colors.primary : colors.selected,
                shape: BoxShape.circle,
              ),
              child: SizedBox.square(
                dimension: 36,
                child: Icon(
                  icon,
                  size: 20,
                  color: onPressed != null ? colors.onPrimary : colors.muted,
                ),
              ),
            ),
          ),
        );

    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 2, 12, 8),
      child: Material(
        color: colors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(22),
          side: BorderSide(color: colors.divider),
        ),
        elevation: 1,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (storageError)
                Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    const Text('无法读取发送状态。'),
                    TextButton(
                      onPressed: onRetryLoad,
                      child: const Text('重试读取'),
                    ),
                  ],
                ),
              if (state case final view?)
                for (final kind in MobileRunMethod.values)
                  if (view.pending[kind] != null ||
                      view.notices[kind] != null ||
                      view.outcomes[kind]?.recovered == true)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
                      child: _PendingRunRow(
                        kind: kind,
                        draft: draft,
                        state: view,
                        online: online,
                        onCheck: () => onCheck(kind),
                        onRetry: () => onRetry(kind),
                      ),
                    ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: draft,
                      key: const ValueKey('run-composer-input'),
                      minLines: 1,
                      maxLines: 5,
                      keyboardType: TextInputType.multiline,
                      textInputAction: TextInputAction.newline,
                      style: const TextStyle(fontSize: 16, height: 1.375),
                      decoration: const InputDecoration(
                        hintText: '发送消息',
                        contentPadding: EdgeInsets.symmetric(
                          horizontal: 4,
                          vertical: 12,
                        ),
                        border: InputBorder.none,
                      ),
                    ),
                  ),
                  ValueListenableBuilder<TextEditingValue>(
                    valueListenable: draft,
                    builder: (context, value, child) {
                      final text = value.text;
                      final canSend =
                          enabled(MobileRunMethod.runStart) &&
                          text.trim().isNotEmpty &&
                          text.length <= mobileCommandTextLimit;
                      return Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          if (runId != null)
                            action(
                              '停止本轮运行',
                              Icons.stop_rounded,
                              enabled(MobileRunMethod.runInterrupt)
                                  ? () => onStop(runId)
                                  : null,
                            ),
                          if (runId == null ||
                              (allowQueue && text.trim().isNotEmpty))
                            action(
                              '发送消息',
                              Icons.arrow_upward,
                              canSend ? () => onSend(text) : null,
                            ),
                        ],
                      );
                    },
                  ),
                ],
              ),
              ValueListenableBuilder<TextEditingValue>(
                valueListenable: draft,
                builder: (context, value, child) =>
                    value.text.length > mobileCommandTextLimit
                    ? Padding(
                        padding: const EdgeInsets.fromLTRB(4, 2, 4, 6),
                        child: Text(
                          '每条消息最多 $mobileCommandTextLimit 个字符。',
                          style: theme.textTheme.bodySmall,
                        ),
                      )
                    : const SizedBox.shrink(),
              ),
            ],
          ),
        ),
      ),
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
