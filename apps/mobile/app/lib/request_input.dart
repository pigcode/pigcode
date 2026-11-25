import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'request_actions.dart';
import 'request_submission.dart';
import 'theme_colors.dart';
import 'timeline/timeline_tokens.dart';
import 'timeline_widgets.dart';
import 'workspace_icon.dart';

typedef RequestDetailsKey = (
  MobileConnection,
  String threadId,
  String runId,
  String requestId,
);

final requestDetailsProvider = FutureProvider.autoDispose
    .family<MobileRequestDetails, RequestDetailsKey>(
      (ref, RequestDetailsKey key) => key.$1.pendingRequests.details(
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
    final provider = requestDetailsProvider((
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
    final touch = _touchSize(context).height;
    final overhang = (touch - 24) / 2;
    final questions = body?.questions;
    final singleQuestion =
        questions?.length == 1 && questions?.single.multiSelect == false;
    final stopBesideTitle =
        onStop != null && (body?.approval != null || singleQuestion);
    final hasActionRow =
        singleQuestion ||
        body?.approval?.decisions.any(
              (decision) => decision != MobileApprovalDecision.allowForSession,
            ) ==
            true;
    final shortFooter =
        remaining == 0 &&
        body?.approval?.decisions.contains(
              MobileApprovalDecision.allowForSession,
            ) ==
            true;
    final bottomInset =
        (shortFooter ? 17 - overhang : 17.0) -
        (theme.platform == TargetPlatform.iOS ? .5 : 0) -
        (hasActionRow ? _actionTouchInset(context) : 0);
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 8),
      child: Semantics(
        button: onStop != null,
        label: onStop == null ? null : '停止本轮运行',
        onTap: onStop,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: colors.surface,
            borderRadius: BorderRadius.circular(24),
            border: Border.all(color: colors.strongBorder),
            // 以方案 D 在 3× 视口中的审批和提问卡片共同校准。
            boxShadow: [
              if (theme.brightness == Brightness.dark)
                const BoxShadow(
                  color: Color(0x21000007),
                  offset: Offset(0, 4.13),
                  blurRadius: 31.23,
                  spreadRadius: 1.36,
                )
              else if (theme.platform == TargetPlatform.android)
                const BoxShadow(
                  color: Color(0x1A18181B),
                  offset: Offset(0, 6),
                  blurRadius: 20.8,
                  spreadRadius: .5,
                )
              else
                const BoxShadow(
                  color: Color(0x1A15151D),
                  offset: Offset(0, 6.02),
                  blurRadius: 21.73,
                  spreadRadius: .57,
                ),
            ],
          ),
          child: Material(
            type: MaterialType.transparency,
            child: Stack(
              children: [
                Padding(
                  padding: EdgeInsets.fromLTRB(17, 17, 17, bottomInset),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (body?.approval case final approval?)
                        RequestApprovalForm(
                          approval: approval,
                          enabled: enabled,
                          onDecision: (decision) => onSubmit(
                            RequestSubmission.approve(target, decision),
                          ),
                        )
                      else if (body?.questions case final questions?)
                        RequestQuestionForm(
                          questions: questions,
                          enabled: enabled,
                          onAnswer: (answers) => onSubmit(
                            RequestSubmission.answer(target, answers),
                          ),
                        )
                      else if (!online)
                        const Text('恢复连接后可处理这项请求。')
                      else if (details.hasError)
                        Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(switch (details.error) {
                              MobileRpcFailure(:final problem)
                                  when problem.code ==
                                      'RESOURCE_NOT_AVAILABLE' =>
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
                        const Center(
                          child: CircularProgressIndicator.adaptive(),
                        ),
                      if (remaining > 0)
                        Text(
                          '还有 $remaining 项待处理',
                          style: theme.textTheme.bodySmall,
                        ),
                    ],
                  ),
                ),
                if (stopBesideTitle)
                  PositionedDirectional(
                    top: 17 - overhang,
                    end: 4,
                    child: SizedBox.square(
                      dimension: touch,
                      child: IconButton(
                        tooltip: '停止本轮运行',
                        onPressed: online ? onStop : null,
                        color: colors.foreground,
                        // 图标按 24 单位画布绘制，19.2 对应原型的 16。
                        icon: const WorkspaceIcon(
                          WorkspaceGlyph.stop,
                          size: 19.2,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class RequestApprovalForm extends StatelessWidget {
  const RequestApprovalForm({
    super.key,
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
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final plan = approval.plan;
    final decisions = approval.decisions;
    final actions = <Widget>[
      if (plan != null) ...[
        if (decisions.contains(MobileApprovalDecision.allowOnce))
          _PermAction(
            label: '开始做',
            primary: true,
            onPressed: enabled
                ? () => onDecision(MobileApprovalDecision.allowOnce)
                : null,
          ),
        if (decisions.contains(MobileApprovalDecision.deny))
          _PermAction(
            label: '再改改',
            onPressed: enabled
                ? () => onDecision(MobileApprovalDecision.deny)
                : null,
          ),
      ] else ...[
        if (decisions.contains(MobileApprovalDecision.allowOnce))
          _PermAction(
            label: '允许一次',
            primary: true,
            onPressed: enabled
                ? () => onDecision(MobileApprovalDecision.allowOnce)
                : null,
          ),
        if (decisions.contains(MobileApprovalDecision.allowForSession))
          _PermAction(
            label: '本会话允许',
            onPressed: enabled
                ? () => onDecision(MobileApprovalDecision.allowForSession)
                : null,
          ),
        if (decisions.contains(MobileApprovalDecision.deny))
          _PermAction(
            label: '拒绝',
            onPressed: enabled
                ? () => onDecision(MobileApprovalDecision.deny)
                : null,
          ),
      ],
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      spacing: TimelineSpace.x6,
      children: [
        Row(
          children: [
            Icon(
              plan != null ? Icons.checklist_rounded : Icons.pan_tool_outlined,
              size: TimelineIcon.row,
              color: colors.timelineSubtle,
            ),
            const SizedBox(width: TimelineSpace.x4),
            Expanded(
              child: Text(
                plan != null
                    ? '计划写好了，开始做吗？'
                    : approval.title ?? approval.toolName,
                style: TimelineType.contentStyle(
                  colors.foreground,
                  weight: FontWeight.w500,
                ),
              ),
            ),
          ],
        ),
        if (approval.description case final description?)
          Text(
            description,
            style: TimelineType.contentStyle(colors.timelineSubtle),
          ),
        if (plan != null)
          ConstrainedBox(
            constraints: const BoxConstraints(
              maxHeight: TimelineToolCard.approvalPlanMaxHeight,
            ),
            child: SingleChildScrollView(
              child: TimelineAnswer(text: plan, padding: EdgeInsets.zero),
            ),
          )
        else if (approval.detail case final detail?)
          Container(
            width: double.infinity,
            constraints: const BoxConstraints(
              maxHeight: TimelineToolCard.approvalDetailMaxHeight,
            ),
            padding: const EdgeInsets.symmetric(
              horizontal: TimelineSpace.x6,
              vertical: TimelineSpace.x4,
            ),
            decoration: BoxDecoration(
              color: colors.timelinePanel,
              border: Border.all(
                color: colors.timelineBorder,
                width: TimelineBorder.regular,
              ),
              borderRadius: BorderRadius.circular(TimelineRadius.block),
            ),
            child: SingleChildScrollView(
              child: Text(
                detail,
                style: TimelineType.codeStyle(colors.foreground),
              ),
            ),
          ),
        if (actions.isNotEmpty)
          Wrap(
            alignment: WrapAlignment.end,
            spacing: TimelineSpace.x3,
            runSpacing: TimelineSpace.x3,
            children: actions,
          ),
      ],
    );
  }
}

class _PermAction extends StatelessWidget {
  const _PermAction({
    required this.label,
    this.primary = false,
    this.onPressed,
  });

  final String label;
  final bool primary;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final enabled = onPressed != null;
    return Semantics(
      button: true,
      enabled: enabled,
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(TimelineRadius.full),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: TimelineSpace.x5),
          child: Opacity(
            opacity: enabled ? 1 : TimelineToolCard.disabledOpacity,
            child: Container(
              height: TimelineControl.sm,
              padding: const EdgeInsets.symmetric(horizontal: TimelineSpace.x5),
              decoration: BoxDecoration(
                color: primary ? colors.foreground : colors.popover,
                border: primary
                    ? null
                    : Border.all(
                        color: colors.timelineBorder,
                        width: TimelineBorder.regular,
                      ),
                borderRadius: BorderRadius.circular(TimelineRadius.full),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    label,
                    style: TimelineType.metaStyle(
                      primary ? colors.background : colors.foreground,
                      weight: primary ? FontWeight.w500 : FontWeight.w400,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class RequestQuestionForm extends StatefulWidget {
  const RequestQuestionForm({
    super.key,
    required this.questions,
    required this.enabled,
    required this.onAnswer,
  });

  final List<MobileQuestion> questions;
  final bool enabled;
  final ValueChanged<List<MobileQuestionAnswer>> onAnswer;

  @override
  State<RequestQuestionForm> createState() => RequestQuestionFormState();
}

class RequestQuestionFormState extends State<RequestQuestionForm> {
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
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final values = answers;
    final complete = values.every(
      (answer) =>
          answer.selected.isNotEmpty || (answer.custom?.isNotEmpty ?? false),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      spacing: TimelineSpace.x6,
      children: [
        Row(
          children: [
            Icon(
              Icons.question_answer_outlined,
              size: TimelineIcon.row,
              color: colors.timelineSubtle,
            ),
            const SizedBox(width: TimelineSpace.x4),
            Expanded(
              child: Text(
                'Agent 想问你几件事',
                style: TimelineType.contentStyle(
                  colors.foreground,
                  weight: FontWeight.w500,
                ),
              ),
            ),
          ],
        ),
        for (final (index, question) in widget.questions.indexed)
          _QuestionField(
            index: index,
            question: question,
            enabled: widget.enabled,
            selected: selected[index] ?? const {},
            custom: custom.putIfAbsent(index, TextEditingController.new),
            onSelect: (label) => _select(index, label, question.multiSelect),
            onOther: (text) => setState(() {
              if (!question.multiSelect && text.trim().isNotEmpty) {
                selected.remove(index);
              }
            }),
          ),
        Wrap(
          alignment: WrapAlignment.end,
          children: [
            _PermAction(
              label: '提交',
              primary: true,
              onPressed: widget.enabled && complete
                  ? () => widget.onAnswer(values)
                  : null,
            ),
          ],
        ),
      ],
    );
  }
}

class _QuestionField extends StatelessWidget {
  const _QuestionField({
    required this.index,
    required this.question,
    required this.enabled,
    required this.selected,
    required this.custom,
    required this.onSelect,
    required this.onOther,
  });

  final int index;
  final MobileQuestion question;
  final bool enabled;
  final Set<String> selected;
  final TextEditingController custom;
  final ValueChanged<String> onSelect;
  final ValueChanged<String> onOther;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: TimelineSpace.x2,
      children: [
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: TimelineSpace.x4,
          runSpacing: TimelineSpace.x1,
          children: [
            if (question.header case final header?)
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: TimelineSpace.x4,
                  vertical: TimelineSpace.x1,
                ),
                decoration: BoxDecoration(
                  color: colors.field,
                  borderRadius: BorderRadius.circular(TimelineRadius.full),
                ),
                child: Text(
                  header,
                  style: TimelineType.smallStyle(
                    colors.timelineSubtle,
                    weight: FontWeight.w500,
                  ),
                ),
              ),
            Text(
              question.question,
              style: TimelineType.contentStyle(
                colors.foreground,
                weight: FontWeight.w500,
              ),
            ),
            if (question.multiSelect)
              Text('可以多选', style: TimelineType.metaStyle(colors.timelineFaint)),
          ],
        ),
        for (final option in question.options)
          _QuestionOption(
            label: option.label,
            description: option.description,
            multi: question.multiSelect,
            selected: selected.contains(option.label),
            enabled: enabled,
            onTap: () => onSelect(option.label),
          ),
        if (question.allowCustomAnswer)
          TextFormField(
            key: ValueKey('other-answer-$index'),
            controller: custom,
            enabled: enabled,
            style: TimelineType.contentStyle(colors.foreground),
            minLines: 1,
            maxLines: 3,
            decoration: InputDecoration(
              hintText: '其他（自己写）',
              hintStyle: TimelineType.metaStyle(colors.timelineFaint),
              isDense: true,
              filled: true,
              fillColor: colors.inputBackground,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(TimelineRadius.block),
                borderSide: BorderSide(color: colors.inputBorder),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(TimelineRadius.block),
                borderSide: BorderSide(color: colors.inputBorder),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: BorderRadius.circular(TimelineRadius.block),
                borderSide: BorderSide(color: colors.strongBorder),
              ),
              contentPadding: const EdgeInsets.symmetric(
                horizontal: TimelineSpace.x6,
                vertical: TimelineSpace.inputVertical,
              ),
            ),
            onChanged: onOther,
          ),
      ],
    );
  }
}

class _QuestionOption extends StatelessWidget {
  const _QuestionOption({
    required this.label,
    required this.description,
    required this.multi,
    required this.selected,
    required this.enabled,
    required this.onTap,
  });

  final String label;
  final String? description;
  final bool multi;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Semantics(
      selected: selected,
      button: true,
      child: InkWell(
        onTap: enabled ? onTap : null,
        borderRadius: BorderRadius.circular(TimelineRadius.block),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: TimelineSpace.x4),
          child: Container(
            constraints: const BoxConstraints(minHeight: TimelineControl.md),
            padding: const EdgeInsets.symmetric(
              horizontal: TimelineSpace.x5,
              vertical: TimelineSpace.x1,
            ),
            decoration: BoxDecoration(
              color: selected ? colors.field : null,
              borderRadius: BorderRadius.circular(TimelineRadius.block),
            ),
            child: Row(
              children: [
                Icon(
                  selected
                      ? (multi
                            ? Icons.check_box_rounded
                            : Icons.radio_button_checked)
                      : (multi
                            ? Icons.check_box_outline_blank
                            : Icons.radio_button_unchecked),
                  size: TimelineIcon.meta,
                  color: selected ? colors.foreground : colors.timelineSubtle,
                ),
                const SizedBox(width: TimelineSpace.x5),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        label,
                        style: TimelineType.contentStyle(colors.foreground),
                      ),
                      if (description case final detail?)
                        Text(
                          detail,
                          style: TimelineType.metaStyle(colors.timelineSubtle),
                        ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
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

// Android 的触区向按钮上下各延伸 1 dp，用相邻留白容纳。
double _actionTouchInset(BuildContext context) =>
    Theme.of(context).platform == TargetPlatform.android ? 1 : 0;
