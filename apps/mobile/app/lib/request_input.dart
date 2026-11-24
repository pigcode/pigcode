import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'request_actions.dart';
import 'request_submission.dart';
import 'theme_colors.dart';
import 'workspace_icon.dart';

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
                        _ApprovalForm(
                          approval: approval,
                          enabled: enabled,
                          reserveStop: stopBesideTitle,
                          onDecision: (decision) => onSubmit(
                            RequestSubmission.approve(target, decision),
                          ),
                        )
                      else if (body?.questions case final questions?)
                        _QuestionForm(
                          questions: questions,
                          enabled: enabled,
                          reserveStop: stopBesideTitle,
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
                    end: 7,
                    child: SizedBox.square(
                      dimension: touch,
                      child: IconButton(
                        tooltip: '停止本轮运行',
                        onPressed: online ? onStop : null,
                        color: colors.muted,
                        icon: const WorkspaceIcon(
                          WorkspaceGlyph.stop,
                          size: 16,
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

class _ApprovalForm extends StatelessWidget {
  const _ApprovalForm({
    required this.approval,
    required this.enabled,
    required this.reserveStop,
    required this.onDecision,
  });
  final MobileApproval approval;
  final bool enabled;
  final bool reserveStop;
  final ValueChanged<MobileApprovalDecision> onDecision;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final plan = approval.plan;
    final actionInset = _actionTouchInset(context);
    final tapTargetSize = actionInset > 0
        ? MaterialTapTargetSize.padded
        : MaterialTapTargetSize.shrinkWrap;
    final actionText = _requestButtonText(theme);
    final actions = [
      if (approval.decisions.contains(MobileApprovalDecision.deny))
        OutlinedButton(
          style: OutlinedButton.styleFrom(
            minimumSize: _actionSize,
            tapTargetSize: tapTargetSize,
            foregroundColor: colors.foreground,
            backgroundColor: colors.surfaceRaised,
            disabledBackgroundColor: Color.alphaBlend(
              colors.surfaceRaised.withValues(alpha: .45),
              colors.surface,
            ),
            side: BorderSide(color: colors.border, width: .5),
            textStyle: actionText,
          ),
          onPressed: enabled
              ? () => onDecision(MobileApprovalDecision.deny)
              : null,
          child: Text(plan == null ? '拒绝' : '继续完善'),
        ),
      if (approval.decisions.contains(MobileApprovalDecision.allowOnce))
        FilledButton(
          style: FilledButton.styleFrom(
            minimumSize: _actionSize,
            tapTargetSize: tapTargetSize,
            textStyle: actionText,
          ),
          onPressed: enabled
              ? () => onDecision(MobileApprovalDecision.allowOnce)
              : null,
          child: Text(plan == null ? '允许本次' : '开始执行'),
        ),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _RequestTitle(
          glyph: WorkspaceGlyph.hand,
          label: plan != null ? '计划待确认' : approval.title ?? approval.toolName,
          reserveStop: reserveStop,
        ),
        if (approval.description case final description?)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: SelectableText(
              description,
              style: TextStyle(color: colors.secondaryText),
            ),
          ),
        if ((plan ?? approval.detail) case final detail?)
          Container(
            width: double.infinity,
            margin: const EdgeInsets.only(top: 12),
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: colors.surfaceSunken,
              borderRadius: BorderRadius.circular(10),
            ),
            child: SelectableText(
              detail,
              style: plan == null
                  ? TextStyle(
                      fontFamily: theme.platform == TargetPlatform.iOS
                          ? 'Menlo'
                          : 'monospace',
                      fontSize: 13,
                      height: 1.45,
                    )
                  : null,
            ),
          ),
        if (actions.isNotEmpty) ...[
          SizedBox(height: 12 - actionInset),
          LayoutBuilder(
            builder: (context, constraints) {
              final labelWidth = MediaQuery.textScalerOf(context).scale(64);
              if (actions.length == 2 &&
                  constraints.maxWidth < 2 * (labelWidth + 24) + 8) {
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    actions.first,
                    const SizedBox(height: 4),
                    actions.last,
                  ],
                );
              }
              return Row(
                children: [
                  for (final (index, action) in actions.indexed) ...[
                    if (index > 0) const SizedBox(width: 10),
                    Expanded(child: action),
                  ],
                ],
              );
            },
          ),
        ],
        if (approval.decisions.contains(
          MobileApprovalDecision.allowForSession,
        )) ...[
          SizedBox(height: 24 - _touchSize(context).height / 2),
          Center(
            child: TextButton(
              style: TextButton.styleFrom(
                minimumSize: _touchSize(context),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                foregroundColor: colors.secondaryText,
                textStyle: theme.textTheme.bodyMedium?.copyWith(
                  fontSize: 14,
                  leadingDistribution: TextLeadingDistribution.even,
                  letterSpacing: theme.platform == TargetPlatform.iOS
                      ? -.24
                      : -.039,
                ),
              ),
              onPressed: enabled
                  ? () => onDecision(MobileApprovalDecision.allowForSession)
                  : null,
              child: const Text('这个会话里都允许'),
            ),
          ),
        ],
      ],
    );
  }
}

class _RequestTitle extends StatelessWidget {
  const _RequestTitle({
    required this.glyph,
    required this.label,
    required this.reserveStop,
  });

  final WorkspaceGlyph glyph;
  final String label;
  final bool reserveStop;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Padding(
      padding: EdgeInsetsDirectional.only(
        end: reserveStop ? _touchSize(context).height - 10 : 0,
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        spacing: 10,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: IconTheme(
              data: IconThemeData(color: colors.attentionMark),
              child: WorkspaceIcon(glyph),
            ),
          ),
          Expanded(
            child: Text(
              label,
              style: theme.textTheme.titleMedium?.copyWith(
                fontSize: 17,
                fontWeight: FontWeight.w500,
                height: 1.45,
                leadingDistribution: TextLeadingDistribution.even,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _QuestionForm extends StatefulWidget {
  const _QuestionForm({
    required this.questions,
    required this.enabled,
    required this.reserveStop,
    required this.onAnswer,
  });
  final List<MobileQuestion> questions;
  final bool enabled;
  final bool reserveStop;
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
    if (widget.questions case [final question] when !question.multiSelect) {
      return _singleQuestion(context, question, values, complete);
    }
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

  Widget _singleQuestion(
    BuildContext context,
    MobileQuestion question,
    List<MobileQuestionAnswer> values,
    bool complete,
  ) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final actionInset = _actionTouchInset(context);
    final submit = FilledButton(
      style: FilledButton.styleFrom(
        minimumSize: _actionSize,
        padding: const EdgeInsets.symmetric(horizontal: 18),
        tapTargetSize: actionInset > 0
            ? MaterialTapTargetSize.padded
            : MaterialTapTargetSize.shrinkWrap,
        disabledBackgroundColor: Color.alphaBlend(
          colors.primary.withValues(alpha: .45),
          colors.surface,
        ),
        disabledForegroundColor: Color.alphaBlend(
          colors.onPrimary.withValues(alpha: .45),
          colors.surface,
        ),
        textStyle: _requestButtonText(theme),
      ),
      onPressed: widget.enabled && complete
          ? () => widget.onAnswer(values)
          : null,
      child: const Text('回答'),
    );
    final Widget footer;
    if (question.allowCustomAnswer) {
      final outline = OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: colors.inputBorder),
      );
      final input = TextFormField(
        key: const ValueKey('other-answer-0'),
        controller: custom.putIfAbsent(0, TextEditingController.new),
        enabled: widget.enabled,
        style: const TextStyle(fontSize: 16, height: 1.45),
        decoration: InputDecoration(
          hintText: '其他回答…',
          hintStyle: TextStyle(color: colors.faint),
          isDense: true,
          filled: true,
          fillColor: colors.inputBackground,
          border: outline,
          enabledBorder: outline,
          contentPadding: const EdgeInsets.symmetric(
            horizontal: 12,
            vertical: 11,
          ),
        ),
        onChanged: (text) => setState(() {
          if (text.trim().isNotEmpty) selected.remove(0);
        }),
      );
      footer = LayoutBuilder(
        builder: (context, constraints) {
          if (constraints.maxWidth <
              MediaQuery.textScalerOf(context).scale(170)) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              spacing: 8,
              children: [input, submit],
            );
          }
          return Row(
            spacing: 8,
            children: [
              Expanded(child: input),
              submit,
            ],
          );
        },
      );
    } else {
      footer = Align(alignment: AlignmentDirectional.centerEnd, child: submit);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _RequestTitle(
          glyph: WorkspaceGlyph.question,
          label: question.question,
          reserveStop: widget.reserveStop,
        ),
        const SizedBox(height: 12),
        Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          spacing: 8,
          children: [
            for (final option in question.options)
              _singleOption(context, option),
          ],
        ),
        SizedBox(height: 12 - actionInset),
        footer,
      ],
    );
  }

  Widget _singleOption(BuildContext context, MobileQuestionOption option) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final checked = selected[0]?.contains(option.label) ?? false;
    return Semantics(
      selected: checked,
      child: TextButton(
        style: TextButton.styleFrom(
          minimumSize: _touchSize(context),
          alignment: AlignmentDirectional.centerStart,
          padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 13),
          foregroundColor: colors.foreground,
          backgroundColor: checked ? colors.selectedOnSurface : colors.surface,
          side: BorderSide(color: checked ? colors.primary : colors.border),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(14),
          ),
        ),
        onPressed: widget.enabled
            ? () => _select(0, option.label, false)
            : null,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          spacing: 2,
          children: [
            Text(
              option.label,
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w500,
                height: 1.45,
              ),
            ),
            if (option.description case final description?)
              Text(
                description,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontSize: 13,
                  height: 1.45,
                  color: colors.muted,
                ),
              ),
          ],
        ),
      ),
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

TextStyle? _requestButtonText(ThemeData theme) =>
    theme.textTheme.titleMedium?.copyWith(
      fontSize: 16,
      fontWeight: FontWeight.w500,
      height: 1.45,
      letterSpacing: theme.platform == TargetPlatform.iOS ? -.24 : -.039,
      leadingDistribution: TextLeadingDistribution.even,
    );

const _actionSize = Size(0, 46);

// Android 的触区向按钮上下各延伸 1 dp，用相邻留白容纳。
double _actionTouchInset(BuildContext context) =>
    Theme.of(context).platform == TargetPlatform.android ? 1 : 0;
