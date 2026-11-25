import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:uuid/uuid.dart';

import 'attachments/attachment_cache.dart';
import 'attachments/image_compressor.dart';
import 'composer/composer_catalog.dart';
import 'run_command_journal.dart';
import 'local_drafts.dart';

typedef ComposerTarget = (MobileConnection connection, String threadId);

class RunCommandOutcome {
  const RunCommandOutcome(this.command, {this.receipt, this.recovered = false});

  final PendingRunCommand command;
  final MobileRunReceipt? receipt;
  final bool recovered;
}

class RunComposerState {
  const RunComposerState({
    this.pending = const {},
    this.working = const {},
    this.notices = const {},
    this.outcomes = const {},
  });

  final Map<MobileRunMethod, PendingRunCommand> pending;
  final Set<MobileRunMethod> working;
  final Map<MobileRunMethod, String> notices;
  final Map<MobileRunMethod, RunCommandOutcome> outcomes;
}

final runComposerProvider = AsyncNotifierProvider.autoDispose
    .family<RunComposerController, RunComposerState, ComposerTarget>(
      RunComposerController.new,
    );

class RunComposerController extends AsyncNotifier<RunComposerState> {
  RunComposerController(this.target)
    : _journal = RunCommandJournal(target.$1, target.$2);

  final ComposerTarget target;
  final RunCommandJournal _journal;
  late final ThreadDraftStorage _draft = ThreadDraftStorage(
    target.$1.computer.computerKey,
    target.$2,
    attachmentCache: ref.read(attachmentCacheProvider),
  );
  MobileRunCommands get _api => target.$1.runCommands;

  @override
  Future<RunComposerState> build() async {
    final pending = <MobileRunMethod, PendingRunCommand>{};
    final notices = <MobileRunMethod, String>{};
    final outcomes = <MobileRunMethod, RunCommandOutcome>{};
    for (final method in MobileRunMethod.values) {
      final command = await _journal.read(method);
      if (!ref.mounted) break;
      if (command == null) continue;
      try {
        final receipt = await _api.receipt(command.commandId);
        if (receipt != null && command.matches(receipt)) {
          if (!ref.mounted) break;
          await _forgetCommand(command, accepted: true);
          outcomes[method] = RunCommandOutcome(
            command,
            receipt: receipt,
            recovered: true,
          );
          continue;
        }
        notices[method] = _waiting(method);
      } catch (_) {
        notices[method] = _waiting(method);
      }
      pending[method] = command;
    }
    return RunComposerState(
      pending: pending,
      notices: notices,
      outcomes: outcomes,
    );
  }

  Future<void> send(
    String text, {
    String? effort,
    bool? fast,
    bool? ultracode,
    List<MobileThreadReference>? references,
    List<String>? attachmentIds,
    bool clearDraftImmediately = false,
    void Function(PendingSend saved)? onReserved,
  }) {
    final supported = connectionSupportsComposerControls(target.$1);
    final supportsAttachments = connectionSupportsAttachments(target.$1);
    final normalizedEffort = effort?.trim();
    return _submit(
      PendingSend(
        MobileStartRunParams(
          commandId: const Uuid().v4(),
          threadId: target.$2,
          text: text,
          effort: supported &&
                  normalizedEffort != null &&
                  normalizedEffort.isNotEmpty
              ? normalizedEffort
              : null,
          fast: supported && fast == true ? true : null,
          ultracode: supported && ultracode == true ? true : null,
          references:
              supported && references != null && references.isNotEmpty
                  ? references
                  : null,
          attachmentIds:
              supportsAttachments &&
                      attachmentIds != null &&
                      attachmentIds.isNotEmpty
                  ? attachmentIds
                  : null,
        ),
      ),
      clearDraftImmediately: clearDraftImmediately,
      onReserved: onReserved,
    );
  }

  Future<void> discard(MobileRunMethod method) async {
    final current = state.value;
    if (current == null || current.working.contains(method)) return;
    final pending = current.pending[method];
    if (pending != null) {
      await _journal.remove(pending, mounted: () => ref.mounted);
    }
    if (!ref.mounted) return;
    final nextPending = {...?state.value?.pending}..remove(method);
    final nextNotices = {...?state.value?.notices}..remove(method);
    final nextOutcomes = {...?state.value?.outcomes}..remove(method);
    _change(
      pending: nextPending,
      notices: nextNotices,
      outcomes: nextOutcomes,
    );
  }

  void clearOutcome(MobileRunMethod method) {
    final current = state.value;
    if (current == null) return;
    if (!current.outcomes.containsKey(method) &&
        !current.notices.containsKey(method)) {
      return;
    }
    _change(
      notices: {...current.notices}..remove(method),
      outcomes: {...current.outcomes}..remove(method),
    );
  }

  Future<void> stop(String runId) => _submit(
    PendingStop(
      MobileInterruptRunParams(
        commandId: const Uuid().v4(),
        threadId: target.$2,
        runId: runId,
      ),
    ),
  );

  Future<void> check(MobileRunMethod method) async {
    final pending = state.value?.pending[method];
    if (pending == null || !_begin(method)) return;
    try {
      await _query(pending);
    } catch (_) {
      _notice(method, _waiting(method));
    } finally {
      _end(method);
    }
  }

  Future<void> retry(MobileRunMethod method) async {
    final pending = state.value?.pending[method];
    if (pending == null || !_begin(method)) return;
    try {
      if (!await _query(pending)) await _transmit(pending);
    } catch (_) {
      _notice(method, _waiting(method));
    } finally {
      _end(method);
    }
  }

  Future<bool> _query(PendingRunCommand command) async {
    final receipt = await _api.receipt(command.commandId);
    if (receipt == null) {
      _notice(command.method, _waiting(command.method));
      return false;
    }
    await _accept(command, receipt, recovered: true);
    return true;
  }

  Future<void> _submit(
    PendingRunCommand command, {
    bool clearDraftImmediately = false,
    void Function(PendingSend saved)? onReserved,
  }) async {
    final method = command.method;
    if (state.value?.pending[method] != null || !_begin(method)) return;
    try {
      final saved = await _journal.reserve(command);
      if (ref.mounted) {
        _change(pending: {...?state.value?.pending, method: saved});
      }
      if (saved.commandId != command.commandId) {
        _notice(method, _waiting(method));
        return;
      }
      if (clearDraftImmediately && saved is PendingSend) {
        await _draft.clearIfMatchesContent(
          saved.params.text,
          attachmentIds: saved.params.attachmentIds ?? const [],
        );
        if (ref.mounted) onReserved?.call(saved);
      }
      await _transmit(saved);
    } catch (_) {
      _notice(method, '无法保存或确认这次操作，请重试。');
    } finally {
      _end(method);
    }
  }

  Future<void> _transmit(PendingRunCommand command) async {
    try {
      await _accept(command, await command.sendVia(_api));
    } on MobileRpcFailure catch (error) {
      if (error.problem.retryable == true) {
        _notice(command.method, _waiting(command.method));
      } else {
        await _settle(
          RunCommandOutcome(command),
          notice: error.problem.message,
        );
      }
    } catch (_) {
      _notice(command.method, _waiting(command.method));
    }
  }

  Future<void> _accept(
    PendingRunCommand command,
    MobileRunReceipt receipt, {
    bool recovered = false,
  }) async {
    if (!command.matches(receipt)) {
      throw const FormatException('Unexpected command receipt');
    }
    await _settle(
      RunCommandOutcome(command, receipt: receipt, recovered: recovered),
    );
  }

  Future<void> _settle(RunCommandOutcome outcome, {String? notice}) async {
    if (!ref.mounted) return;
    final command = outcome.command;
    await _forgetCommand(command, accepted: outcome.receipt != null);
    if (!ref.mounted) return;
    final pending = {...?state.value?.pending}..remove(command.method);
    final notices = {...?state.value?.notices}..remove(command.method);
    if (notice != null) notices[command.method] = notice;
    _change(
      pending: pending,
      notices: notices,
      outcomes: {...?state.value?.outcomes, command.method: outcome},
    );
  }

  Future<void> _forgetCommand(
    PendingRunCommand command, {
    required bool accepted,
  }) => _journal.remove(
    command,
    mounted: () => ref.mounted,
    beforeRemove: accepted && command is PendingSend
        ? () => _draft.clearIfMatchesContent(
            command.params.text,
            attachmentIds: command.params.attachmentIds ?? const [],
          )
        : null,
  );

  bool _begin(MobileRunMethod method) {
    final current = state.value;
    if (current == null || current.working.contains(method)) return false;
    _change(
      working: {...current.working, method},
      notices: {...current.notices}..remove(method),
      outcomes: {...current.outcomes}..remove(method),
    );
    return true;
  }

  void _end(MobileRunMethod method) {
    if (!ref.mounted) return;
    _change(working: {...?state.value?.working}..remove(method));
  }

  void _notice(MobileRunMethod method, String text) {
    if (!ref.mounted) return;
    _change(notices: {...?state.value?.notices, method: text});
  }

  String _waiting(MobileRunMethod method) => switch (method) {
    MobileRunMethod.runStart => '发送结果待确认',
    MobileRunMethod.runInterrupt => '停止结果待确认',
  };

  void _change({
    Map<MobileRunMethod, PendingRunCommand>? pending,
    Set<MobileRunMethod>? working,
    Map<MobileRunMethod, String>? notices,
    Map<MobileRunMethod, RunCommandOutcome>? outcomes,
  }) {
    if (!ref.mounted || state.value == null) return;
    final current = state.requireValue;
    state = AsyncData(
      RunComposerState(
        pending: pending ?? current.pending,
        working: working ?? current.working,
        notices: notices ?? current.notices,
        outcomes: outcomes ?? current.outcomes,
      ),
    );
  }
}
