import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../request_actions.dart';
import '../request_input.dart';
import '../request_submission.dart';
import '../theme_colors.dart';
import 'timeline_tokens.dart';

/// 轮次内联的审批/提问卡：按 request id 读取详情，提交仍走回执状态机。
class InlineRequestCard extends ConsumerWidget {
  const InlineRequestCard({
    super.key,
    required this.connection,
    required this.threadId,
    required this.runId,
    required this.requestId,
    required this.online,
  });

  final MobileConnection connection;
  final String threadId;
  final String runId;
  final String requestId;
  final bool online;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final target = MobileRequestTarget(
      threadId: threadId,
      runId: runId,
      requestId: requestId,
    );
    final details = ref.watch(
      requestDetailsProvider((connection, threadId, runId, requestId)),
    );
    final actionsProvider = requestActionsProvider((connection, threadId));
    final state = ref.watch(actionsProvider).value;
    final actions = ref.read(actionsProvider.notifier);
    final confirmed = state?.confirmed.contains(requestId) ?? false;
    final unresolved = state?.pending.containsKey(requestId) ?? false;
    final working = state?.working.contains(requestId) ?? false;
    final enabled = online && !confirmed && !working && !unresolved;

    final Widget body;
    if (confirmed) {
      body = Row(
        children: [
          Icon(
            Icons.check_rounded,
            size: TimelineIcon.meta,
            color: colors.readyMark,
          ),
          const SizedBox(width: TimelineSpace.x4),
          Text(
            '已处理这项请求',
            style: TimelineType.contentStyle(colors.timelineSubtle),
          ),
        ],
      );
    } else {
      body = details.when(
        data: (value) => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (value.approval case final approval?)
              RequestApprovalForm(
                approval: approval,
                enabled: enabled,
                onDecision: (decision) =>
                    actions.submit(RequestSubmission.approve(target, decision)),
              )
            else if (value.questions case final questions?)
              RequestQuestionForm(
                questions: questions,
                enabled: enabled,
                onAnswer: (answers) =>
                    actions.submit(RequestSubmission.answer(target, answers)),
              ),
            if (unresolved) ...[
              const SizedBox(height: TimelineSpace.x4),
              Row(
                children: [
                  Expanded(
                    child: Text(
                      '提交结果待确认',
                      style: TimelineType.metaStyle(colors.attention),
                    ),
                  ),
                  TextButton(
                    onPressed: () => actions.check(requestId, retry: true),
                    child: const Text('查回执'),
                  ),
                ],
              ),
            ],
          ],
        ),
        loading: () => Row(
          children: [
            const SizedBox.square(
              dimension: TimelineIcon.meta,
              child: CircularProgressIndicator(strokeWidth: TimelineSpace.x1),
            ),
            const SizedBox(width: TimelineSpace.x4),
            Text(
              '正在读取审批/提问…',
              style: TimelineType.metaStyle(colors.timelineFaint),
            ),
          ],
        ),
        error: (_, _) => Row(
          children: [
            Expanded(
              child: Text(
                '暂时无法读取这项请求。',
                style: TimelineType.metaStyle(colors.error),
              ),
            ),
            TextButton(
              onPressed: () => ref.invalidate(
                requestDetailsProvider((
                  connection,
                  threadId,
                  runId,
                  requestId,
                )),
              ),
              child: const Text('重试'),
            ),
          ],
        ),
      );
    }

    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: TimelineSpace.x2),
      padding: TimelineSpace.card,
      decoration: BoxDecoration(
        color: colors.popover,
        border: Border.all(
          color: colors.timelineBorder,
          width: TimelineBorder.regular,
        ),
        borderRadius: BorderRadius.circular(TimelineRadius.panel),
        boxShadow: TimelineShadow.md(theme.brightness),
      ),
      child: body,
    );
  }
}
