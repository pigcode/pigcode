import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'mobile_command_journal.dart';
import 'request_submission.dart';

typedef RequestThread = (MobileConnection connection, String threadId);

class RequestActionsState {
  const RequestActionsState({
    this.pending = const {},
    this.working = const {},
    this.confirmed = const {},
    this.notice,
  });

  final Map<String, RequestSubmission> pending;
  final Set<String> working;
  final Set<String> confirmed;
  final String? notice;
}

final requestActionsProvider = AsyncNotifierProvider.autoDispose
    .family<RequestActions, RequestActionsState, RequestThread>(
      RequestActions.new,
    );

class RequestActions extends AsyncNotifier<RequestActionsState> {
  RequestActions(this.thread)
    : _journal = MobileCommandJournal(
        thread.$1,
        thread.$2,
        RequestSubmission.decode,
      );

  final RequestThread thread;
  final MobileCommandJournal<RequestSubmission> _journal;
  MobilePendingRequests get _api => thread.$1.pendingRequests;

  @override
  Future<RequestActionsState> build() async {
    final saved = await _journal.readMatching(RequestSubmission.slotPrefix);
    final pending = <String, RequestSubmission>{};
    final confirmed = <String>{};
    String? notice;
    for (final command in saved) {
      if (!ref.mounted) break;
      try {
        final receipt = await _api.receipt(command.commandId);
        if (receipt != null && command.matches(receipt) && ref.mounted) {
          await _journal.remove(command, mounted: () => ref.mounted);
          confirmed.add(command.requestId);
          notice = requestOutcomeLabel(receipt.outcome, recovered: true);
          continue;
        }
      } catch (_) {
        // The saved command stays available for an explicit retry.
      }
      pending[command.requestId] = command;
    }
    return RequestActionsState(
      pending: pending,
      confirmed: confirmed,
      notice: notice,
    );
  }

  Future<void> submit(RequestSubmission command) async {
    if (!command.fitsTransport) {
      _notice('回答太长，请缩短后提交。');
      return;
    }
    final id = command.requestId;
    if (state.value?.pending[id] != null || !_begin(id)) return;
    try {
      final saved = await _journal.reserve(command);
      _update(
        (current) => RequestActionsState(
          pending: {...current.pending, id: saved},
          working: current.working,
          confirmed: current.confirmed,
        ),
      );
      if (saved.commandId == command.commandId) await _transmit(saved);
    } catch (_) {
      _notice('无法保存操作，请重试。');
    } finally {
      _end(id);
    }
  }

  Future<void> check(String id, {bool retry = false}) async {
    final pending = state.value?.pending[id];
    if (pending == null || !_begin(id)) return;
    try {
      final receipt = await _api.receipt(pending.commandId);
      if (receipt != null) {
        await _accept(pending, receipt, recovered: true);
      } else if (retry) {
        await _transmit(pending);
      }
    } catch (_) {
      _notice('暂时无法确认，请稍后查回执。');
    } finally {
      _end(id);
    }
  }

  Future<void> _transmit(RequestSubmission command) async {
    try {
      await _accept(command, await command.sendVia(_api));
    } on MobileRpcFailure catch (error) {
      if (error.problem.retryable == true) {
        _notice('提交结果待确认');
      } else {
        await _settle(command, error.problem.message);
      }
    } catch (_) {
      _notice('提交结果待确认');
    }
  }

  Future<void> _accept(
    RequestSubmission command,
    MobileRequestReceipt receipt, {
    bool recovered = false,
  }) async {
    if (!command.matches(receipt)) {
      throw const FormatException('Unexpected receipt');
    }
    await _settle(
      command,
      requestOutcomeLabel(receipt.outcome, recovered: recovered),
      confirmsResult: true,
    );
  }

  Future<void> _settle(
    RequestSubmission command,
    String notice, {
    bool confirmsResult = false,
  }) async {
    if (!ref.mounted) return;
    await _journal.remove(command, mounted: () => ref.mounted);
    _update(
      (current) => RequestActionsState(
        pending: {...current.pending}..remove(command.requestId),
        working: current.working,
        confirmed: confirmsResult
            ? {...current.confirmed, command.requestId}
            : current.confirmed,
        notice: notice,
      ),
    );
  }

  bool _begin(String id) {
    final current = state.value;
    if (!ref.mounted ||
        current == null ||
        current.working.contains(id) ||
        current.confirmed.contains(id)) {
      return false;
    }
    state = AsyncData(
      RequestActionsState(
        pending: current.pending,
        working: {...current.working, id},
        confirmed: current.confirmed,
      ),
    );
    return true;
  }

  void _end(String id) => _update(
    (current) => RequestActionsState(
      pending: current.pending,
      working: {...current.working}..remove(id),
      confirmed: current.confirmed,
      notice: current.notice,
    ),
  );

  void _notice(String text) => _update(
    (current) => RequestActionsState(
      pending: current.pending,
      working: current.working,
      confirmed: current.confirmed,
      notice: text,
    ),
  );

  void _update(RequestActionsState Function(RequestActionsState) update) {
    if (!ref.mounted) return;
    if (state.value case final value?) state = AsyncData(update(value));
  }
}

String requestOutcomeLabel(
  MobileRequestOutcome outcome, {
  bool recovered = false,
}) {
  if (outcome.state == MobileRequestState.expired) return '这项请求已失效';
  final decision = switch (outcome.decision) {
    MobileApprovalDecision.allowOnce => '已允许一次',
    MobileApprovalDecision.allowForSession => '本会话已允许',
    MobileApprovalDecision.deny => '已拒绝',
    null =>
      '已回答 · ${outcome.answers?.join(' / ') ?? ''}${outcome.answersTruncated == true ? '（部分内容）' : ''}',
  };
  if (outcome.state == MobileRequestState.alreadyHandled) {
    return '另一端已处理 · $decision';
  }
  return recovered ? '已找回回执 · $decision' : decision;
}
