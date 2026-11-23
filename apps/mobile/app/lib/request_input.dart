import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'request_actions.dart';
import 'request_submission.dart';
import 'theme_colors.dart';

typedef _RequestDetailsKey = (
  MobileConnection,
  String threadId,
  String runId,
  String requestId,
);

final _requestDetailsProvider = FutureProvider.autoDispose
    .family<MobileRequestDetails, _RequestDetailsKey>(
      (ref, _RequestDetailsKey key) => key.$1.pendingRequests.details(
        MobileRequestTarget(threadId: key.$2, runId: key.$3, requestId: key.$4),
      ),
    );

class RequestInput extends ConsumerWidget {
  const RequestInput({
    super.key,
    required this.connection,
    required this.threadId,
    required this.live,
    required this.online,
    required this.composer,
    this.onStop,
  });

  final MobileConnection connection;
  final String threadId;
  final MobileActiveRun? live;
  final bool online;
  final Widget composer;
  final VoidCallback? onStop;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = requestActionsProvider((connection, threadId));
    final actions = ref.read(provider.notifier);
    final view = ref.watch(provider);
    final state = view.value;
    final run = live;
    final pending =
        run?.pending
            .where((item) => state?.confirmed.contains(item.id) != true)
            .toList() ??
        const <MobileTimelinePending>[];
    final first = pending.firstOrNull;
    final notice = state?.notice;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Visibility(
          visible: first == null,
          maintainState: true,
          child: composer,
        ),
        if (first != null && run != null)
          _ActiveRequest(
            key: ValueKey(first.id),
            connection: connection,
            target: MobileRequestTarget(
              threadId: threadId,
              runId: run.runId,
              requestId: first.id,
            ),
            online: online,
            remaining: pending.length - 1,
            working: state?.working.contains(first.id) ?? false,
            unresolved: state?.pending.containsKey(first.id) ?? false,
            ready: state != null && !view.hasError,
            onStop: onStop,
            onSubmit: actions.submit,
          ),
        if (state != null)
          for (final entry in state.pending.entries)
            _RequestReceiptRow(
              working: state.working.contains(entry.key),
              online: online,
              onCheck: () => actions.check(entry.key),
              onRetry: () => actions.check(entry.key, retry: true),
            ),
        if (notice != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: Semantics(
              liveRegion: true,
              child: Text(notice, style: Theme.of(context).textTheme.bodySmall),
            ),
          ),
        if (view.hasError)
          TextButton(
            onPressed: () => ref.invalidate(provider),
            child: const Text('重试读取待处理状态'),
          ),
      ],
    );
  }
}

class _ActiveRequest extends ConsumerWidget {
  const _ActiveRequest({
    super.key,
    required this.connection,
    required this.target,
    required this.online,
    required this.remaining,
    required this.ready,
    required this.working,
    required this.unresolved,
    required this.onSubmit,
    this.onStop,
  });

  final MobileConnection connection;
  final MobileRequestTarget target;
  final bool online;
  final int remaining;
  final bool ready;
  final bool working;
  final bool unresolved;
  final ValueChanged<RequestSubmission> onSubmit;
  final VoidCallback? onStop;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = _requestDetailsProvider((
      connection,
      target.threadId,
      target.runId,
      target.requestId,
    ));
    final details = online
        ? ref.watch(provider)
        : const AsyncLoading<MobileRequestDetails>();
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final enabled = online && ready && !working && !unresolved;
    final body = details.value;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 2, 12, 8),
      child: Material(
        color: colors.surface,
        shadowColor: colors.scrim,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(24),
          side: BorderSide(color: colors.divider, width: .5),
        ),
        elevation: 1,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              if (body?.approval case final approval?)
                _ApprovalForm(
                  approval: approval,
                  enabled: enabled,
                  onDecision: (decision) =>
                      onSubmit(RequestSubmission.approve(target, decision)),
                )
              else if (body?.questions case final questions?)
                _QuestionForm(
                  questions: questions,
                  enabled: enabled,
                  onAnswer: (answers) =>
                      onSubmit(RequestSubmission.answer(target, answers)),
                )
              else if (!online)
                const Text('恢复连接后可处理这项请求。')
              else if (details.hasError)
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(switch (details.error) {
                      MobileRpcFailure(:final problem)
                          when problem.code == 'RESOURCE_NOT_AVAILABLE' =>
                        '这项请求已结束。',
                      MobileRpcFailure(:final problem)
                          when problem.code == 'RESULT_TOO_LARGE' =>
                        '请求内容较长，请在电脑查看。',
                      _ => '暂时无法读取这项请求。',
                    }),
                    TextButton(
                      onPressed: () => ref.invalidate(provider),
                      child: const Text('重新读取'),
                    ),
                  ],
                )
              else
                const Center(child: CircularProgressIndicator.adaptive()),
              if (remaining > 0)
                Text('还有 $remaining 项待处理', style: theme.textTheme.bodySmall),
              if (onStop != null)
                Align(
                  alignment: AlignmentDirectional.centerEnd,
                  child: TextButton(
                    onPressed: online ? onStop : null,
                    child: const Text('停止本轮运行'),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ApprovalForm extends StatelessWidget {
  const _ApprovalForm({
    required this.approval,
    required this.enabled,
    required this.onDecision,
  });
  final MobileApproval approval;
  final bool enabled;
  final ValueChanged<MobileApprovalDecision> onDecision;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final plan = approval.plan;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          plan != null ? '计划待确认' : approval.title ?? approval.toolName,
          style: theme.textTheme.titleSmall,
        ),
        if (approval.description case final description?)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: SelectableText(description),
          ),
        if ((plan ?? approval.detail) case final detail?)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: SelectableText(
              detail,
              style: plan == null
                  ? const TextStyle(fontFamily: 'monospace', fontSize: 13)
                  : null,
            ),
          ),
        Wrap(
          spacing: 8,
          runSpacing: 4,
          children: [
            for (final decision in approval.decisions)
              if (decision == MobileApprovalDecision.allowOnce)
                FilledButton(
                  style: FilledButton.styleFrom(
                    minimumSize: _touchSize(context),
                  ),
                  onPressed: enabled ? () => onDecision(decision) : null,
                  child: Text(plan == null ? '允许一次' : '开始执行'),
                )
              else
                OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    minimumSize: _touchSize(context),
                  ),
                  onPressed: enabled ? () => onDecision(decision) : null,
                  child: Text(
                    decision == MobileApprovalDecision.allowForSession
                        ? '本会话允许'
                        : plan == null
                        ? '拒绝'
                        : '继续完善',
                  ),
                ),
          ],
        ),
      ],
    );
  }
}

class _QuestionForm extends StatefulWidget {
  const _QuestionForm({
    required this.questions,
    required this.enabled,
    required this.onAnswer,
  });
  final List<MobileQuestion> questions;
  final bool enabled;
  final ValueChanged<List<MobileQuestionAnswer>> onAnswer;

  @override
  State<_QuestionForm> createState() => _QuestionFormState();
}

class _QuestionFormState extends State<_QuestionForm> {
  final selected = <int, Set<String>>{};
  final custom = <int, TextEditingController>{};

  @override
  void dispose() {
    for (final field in custom.values) {
      field.dispose();
    }
    super.dispose();
  }

  List<MobileQuestionAnswer> get answers => [
    for (var index = 0; index < widget.questions.length; index++)
      _answer(index),
  ];

  MobileQuestionAnswer _answer(int index) {
    final text = custom[index]?.text.trim();
    return MobileQuestionAnswer(
      selected: selected[index]?.toList() ?? const [],
      custom: text?.isEmpty == true ? null : text,
    );
  }

  void _select(int index, String label, bool multi) {
    setState(() {
      if (!multi) {
        selected[index] = {label};
        custom[index]?.clear();
        return;
      }
      final current = selected.putIfAbsent(index, () => {});
      if (!current.remove(label)) current.add(label);
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final values = answers;
    final complete = values.every(
      (answer) =>
          answer.selected.isNotEmpty || (answer.custom?.isNotEmpty ?? false),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Agent 提问', style: theme.textTheme.titleSmall),
        for (final (index, question) in widget.questions.indexed) ...[
          const SizedBox(height: 12),
          if (question.header case final header?)
            Text(header, style: theme.textTheme.labelMedium),
          Text(question.question),
          if (question.multiSelect)
            Text('可多选', style: theme.textTheme.bodySmall),
          for (final option in question.options)
            Semantics(
              selected: selected[index]?.contains(option.label) ?? false,
              child: TextButton(
                style: TextButton.styleFrom(
                  minimumSize: _touchSize(context),
                  alignment: AlignmentDirectional.centerStart,
                ),
                onPressed: widget.enabled
                    ? () => _select(index, option.label, question.multiSelect)
                    : null,
                child: Row(
                  children: [
                    Icon(
                      _optionIcon(index, option.label, question.multiSelect),
                      size: 20,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(option.label),
                          if (option.description case final description?)
                            Text(description, style: theme.textTheme.bodySmall),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ),
          if (question.allowCustomAnswer)
            TextFormField(
              key: ValueKey('other-answer-$index'),
              controller: custom.putIfAbsent(index, TextEditingController.new),
              enabled: widget.enabled,
              decoration: const InputDecoration(labelText: '其他'),
              maxLines: 3,
              minLines: 1,
              onChanged: (text) => setState(() {
                if (!question.multiSelect && text.trim().isNotEmpty) {
                  selected.remove(index);
                }
              }),
            ),
        ],
        const SizedBox(height: 8),
        Align(
          alignment: AlignmentDirectional.centerEnd,
          child: FilledButton(
            style: FilledButton.styleFrom(minimumSize: _touchSize(context)),
            onPressed: widget.enabled && complete
                ? () => widget.onAnswer(values)
                : null,
            child: const Text('提交回答'),
          ),
        ),
      ],
    );
  }

  IconData _optionIcon(int index, String label, bool multi) {
    final checked = selected[index]?.contains(label) ?? false;
    if (multi) return checked ? Icons.check_box : Icons.check_box_outline_blank;
    return checked ? Icons.radio_button_checked : Icons.radio_button_unchecked;
  }
}

class _RequestReceiptRow extends StatelessWidget {
  const _RequestReceiptRow({
    required this.working,
    required this.online,
    required this.onCheck,
    required this.onRetry,
  });
  final bool working;
  final bool online;
  final VoidCallback onCheck;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 16),
    child: Wrap(
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(working ? '正在确认提交…' : '提交结果待确认'),
        if (!working) ...[
          TextButton(
            onPressed: online ? onCheck : null,
            child: const Text('查回执'),
          ),
          TextButton(
            onPressed: online ? onRetry : null,
            child: const Text('用原编号重试'),
          ),
        ],
      ],
    ),
  );
}

Size _touchSize(BuildContext context) =>
    Size(0, Theme.of(context).platform == TargetPlatform.android ? 48 : 44);
