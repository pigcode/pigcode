import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:uuid/uuid.dart';

import 'mobile_command_journal.dart';
import 'theme_colors.dart';

typedef _QueueTarget = (MobileConnection connection, String threadId);

final _snapshotProvider = FutureProvider.autoDispose
    .family<QueueSnapshot, _QueueTarget>(
      (ref, target) => target.$1.queue.snapshot(target.$2),
    );

class _QueueOperation implements JournalCommand {
  _QueueOperation(this.method, this.params);

  final QueueMethod method;
  final Map<String, Object?> params;

  @override
  String get slot => 'queue';
  @override
  String get commandId => params['commandId'] as String;
  String get threadId => params['threadId'] as String;

  @override
  Map<String, Object?> toJson() => {'method': method.wire, 'params': params};

  static _QueueOperation decode(String slot, Map<String, dynamic> json) =>
      _QueueOperation(
        QueueMethod.fromWire(json['method'] as String),
        json['params'] as Map<String, dynamic>,
      );

  bool matches(QueueReceipt receipt) =>
      receipt.commandId == commandId &&
      receipt.method == method &&
      receipt.threadId == threadId &&
      (params['messageId'] == null || receipt.messageId == params['messageId']);
}

class _QueueActionState {
  const _QueueActionState({
    this.pending,
    this.receipt,
    this.working = false,
    this.notice,
  });
  final _QueueOperation? pending;
  final QueueReceipt? receipt;
  final bool working;
  final String? notice;
}

final _actionsProvider = AsyncNotifierProvider.autoDispose
    .family<_QueueActions, _QueueActionState, _QueueTarget>(_QueueActions.new);

class _QueueActions extends AsyncNotifier<_QueueActionState> {
  _QueueActions(this.target)
    : _journal = MobileCommandJournal(
        target.$1,
        target.$2,
        _QueueOperation.decode,
      );

  final _QueueTarget target;
  final MobileCommandJournal<_QueueOperation> _journal;
  MobileQueueCommands get _api => target.$1.queue;

  @override
  Future<_QueueActionState> build() async {
    final pending = await _journal.read('queue');
    if (pending == null || !ref.mounted) return const _QueueActionState();
    try {
      final receipt = await _api.receipt(pending.commandId);
      if (receipt != null && pending.matches(receipt)) {
        return _QueueActionState(pending: pending, receipt: receipt);
      }
    } catch (_) {
      // Keep the original operation for explicit retry.
    }
    return _QueueActionState(pending: pending);
  }

  Future<void> submit(
    QueueMethod method, {
    String? messageId,
    String? runId,
  }) async {
    final current = state.value;
    if (current == null || current.working || current.pending != null) return;
    final operation = _QueueOperation(method, {
      'threadId': target.$2,
      'commandId': const Uuid().v4(),
      'messageId': ?messageId,
      'runId': ?runId,
    });
    state = const AsyncData(_QueueActionState(working: true));
    try {
      final saved = await _journal.reserve(operation);
      if (!ref.mounted) return;
      state = AsyncData(_QueueActionState(pending: saved, working: true));
      if (saved.commandId == operation.commandId) await _transmit(saved);
    } catch (_) {
      _notice(state.value?.pending == null ? '暂时无法保存待发操作。' : '暂时无法确认待发操作。');
    } finally {
      _end();
    }
  }

  Future<void> check({bool retry = false}) async {
    final current = state.value;
    final pending = current?.pending;
    if (pending == null || current!.working || current.receipt != null) return;
    state = AsyncData(_QueueActionState(pending: pending, working: true));
    try {
      final receipt = await _api.receipt(pending.commandId);
      if (receipt != null) {
        _resolve(pending, receipt);
      } else if (retry) {
        await _transmit(pending);
      }
    } catch (_) {
      _notice('暂时查不到回执。');
    } finally {
      _end();
    }
  }

  Future<void> _transmit(_QueueOperation operation) async {
    try {
      _resolve(
        operation,
        await _api.submit(operation.method, operation.params),
      );
    } on MobileRpcFailure catch (error) {
      if (error.problem.retryable != true && ref.mounted) {
        await _journal.remove(operation, mounted: () => ref.mounted);
        if (ref.mounted) {
          state = AsyncData(_QueueActionState(notice: error.problem.message));
          ref.invalidate(_snapshotProvider(target));
        }
      }
    }
  }

  void _resolve(_QueueOperation operation, QueueReceipt receipt) {
    if (!operation.matches(receipt)) {
      throw const FormatException('Unexpected queue receipt');
    }
    if (ref.mounted) {
      state = AsyncData(
        _QueueActionState(pending: operation, receipt: receipt),
      );
    }
  }

  Future<void> acknowledge(String commandId) async {
    final operation = state.value?.pending;
    if (operation?.commandId != commandId) return;
    try {
      await _journal.remove(operation!, mounted: () => ref.mounted);
      if (ref.mounted && state.value?.pending?.commandId == commandId) {
        state = const AsyncData(_QueueActionState());
      }
    } catch (_) {
      _notice('回执已确认，本机记录尚待清理。');
    }
  }

  void _notice(String text) {
    if (!ref.mounted || state.value == null) return;
    final current = state.requireValue;
    state = AsyncData(
      _QueueActionState(
        pending: current.pending,
        receipt: current.receipt,
        notice: text,
      ),
    );
  }

  void _end() {
    if (!ref.mounted || state.value?.working != true) return;
    final current = state.requireValue;
    state = AsyncData(
      _QueueActionState(
        pending: current.pending,
        receipt: current.receipt,
        notice: current.notice,
      ),
    );
  }
}

class MessageQueuePanel extends ConsumerStatefulWidget {
  const MessageQueuePanel({
    super.key,
    required this.connection,
    required this.threadId,
    required this.revision,
    required this.online,
    required this.onWithdraw,
  });

  final MobileConnection connection;
  final String threadId;
  final int revision;
  final bool online;
  final ValueChanged<String> onWithdraw;

  @override
  ConsumerState<MessageQueuePanel> createState() => _MessageQueuePanelState();
}

class _MessageQueuePanelState extends ConsumerState<MessageQueuePanel> {
  _QueueTarget get _target => (widget.connection, widget.threadId);

  @override
  void didUpdateWidget(covariant MessageQueuePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.revision != oldWidget.revision ||
        (widget.online && !oldWidget.online)) {
      final target = _target;
      Future<void>.microtask(() {
        if (mounted && _target == target && widget.online) {
          ref.invalidate(_snapshotProvider(target));
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = ref.watch(_snapshotProvider(_target)).value;
    final actions = _actionsProvider(_target);
    final status = ref.watch(actions);
    final values = status.value;
    final controller = ref.read(actions.notifier);
    ref.listen(actions, (previous, next) {
      final receipt = next.value?.receipt;
      if (receipt == null ||
          receipt.commandId == previous?.value?.receipt?.commandId) {
        return;
      }
      if (receipt.effect == QueueEffect.withdrawn && receipt.text != null) {
        widget.onWithdraw(receipt.text!);
      }
      unawaited(controller.acknowledge(receipt.commandId));
      ref.invalidate(_snapshotProvider(_target));
    });
    final messages = snapshot?.messages ?? const [];
    final pending = values?.pending;
    if (messages.isEmpty &&
        pending == null &&
        values?.notice == null &&
        !status.hasError) {
      return const SizedBox.shrink();
    }
    final active = snapshot?.activeRunId;
    final paused = snapshot?.paused == true;
    final ready =
        widget.online && values != null && !values.working && pending == null;
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 2, 12, 4),
      child: Material(
        color: colors.surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(22),
          side: BorderSide(color: colors.divider),
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(child: Text(paused ? '待发队列已暂停' : '待发消息')),
                  if (paused)
                    TextButton(
                      onPressed: ready
                          ? () => controller.submit(QueueMethod.queueResume)
                          : null,
                      child: const Text('继续发送'),
                    ),
                ],
              ),
              for (final message in messages)
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        message.text,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                    if (message.selected)
                      const Text('准备发送')
                    else ...[
                      TextButton(
                        onPressed: ready
                            ? () => controller.submit(
                                QueueMethod.queueWithdraw,
                                messageId: message.id,
                              )
                            : null,
                        child: const Text('撤回'),
                      ),
                      if (active != null)
                        TextButton(
                          onPressed: ready
                              ? () => controller.submit(
                                  QueueMethod.queueStopAndSend,
                                  messageId: message.id,
                                  runId: active,
                                )
                              : null,
                          child: const Text('停止并发送'),
                        ),
                    ],
                  ],
                ),
              if (values?.notice case final notice?) Text(notice),
              if (pending != null && values?.receipt == null)
                Wrap(
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    const Text('待发操作结果待确认'),
                    TextButton(
                      onPressed: widget.online && values?.working == false
                          ? () => controller.check()
                          : null,
                      child: const Text('查回执'),
                    ),
                    TextButton(
                      onPressed: widget.online && values?.working == false
                          ? () => controller.check(retry: true)
                          : null,
                      child: const Text('用原编号重试'),
                    ),
                  ],
                ),
              if (status.hasError)
                TextButton(
                  onPressed: () => ref.invalidate(actions),
                  child: const Text('重新读取待发操作'),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
