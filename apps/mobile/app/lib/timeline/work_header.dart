import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../theme_colors.dart';
import 'timeline_tokens.dart';

/// 工作区折叠头的文案：正常结束「用时 N 秒」，被停止「已停止」，没有时间「已处理」。
String timelineWorkLabel(TimelineTurn turn) {
  if (turn.status == TimelineTurnStatus.interrupted) return '已停止';
  final start = DateTime.tryParse(turn.startedAt);
  final end = DateTime.tryParse(turn.terminal?.createdAt ?? '');
  if (start == null || end == null) return '已处理';
  return '用时 ${formatTimelineDuration(end.difference(start))}';
}

/// 结束轮的工作折叠头（桌面 `.work-head`）：次级文字 15/24、底部 8px 内衬 + `--cv-hairline` 细线、
/// 箭头 `--cv-subtlest` 0.7 透明度、展开旋转 90°。
class TimelineWorkHeader extends StatelessWidget {
  const TimelineWorkHeader({
    super.key,
    required this.turn,
    required this.open,
    required this.canToggle,
    this.onToggle,
  });

  final TimelineTurn turn;
  final bool open;
  final bool canToggle;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final line = DecoratedBox(
      decoration: BoxDecoration(
        border: Border(
          bottom: BorderSide(
            color: colors.timelineDivider,
            width: TimelineBorder.regular,
          ),
        ),
      ),
      child: Padding(
        padding: const EdgeInsets.only(bottom: TimelineSpace.x4),
        child: Row(
          children: [
            Flexible(
              child: Text(
                timelineWorkLabel(turn),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TimelineType.contentStyle(
                  colors.timelineSubtle,
                ).copyWith(fontFeatures: TimelineType.tabular),
              ),
            ),
            if (canToggle) ...[
              const SizedBox(width: TimelineSpace.fieldGap),
              AnimatedRotation(
                turns: open ? 0.25 : 0,
                duration: MediaQuery.disableAnimationsOf(context)
                    ? Duration.zero
                    : TimelineMotion.slow,
                curve: TimelineMotion.ease,
                child: Icon(
                  Icons.chevron_right,
                  size: TimelineIcon.meta,
                  color: colors.timelineFaint.withValues(
                    alpha: TimelineSummary.workChevronOpacity,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );

    if (!canToggle) return line;
    final hit = timelineTouchHeight(context);
    return Semantics(
      expanded: open,
      button: true,
      child: InkWell(
        key: ValueKey('fold-${turn.key}'),
        onTap: onToggle,
        borderRadius: BorderRadius.circular(TimelineRadius.xs),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: hit),
          child: Align(
            alignment: AlignmentDirectional.topStart,
            heightFactor: 1,
            child: line,
          ),
        ),
      ),
    );
  }
}
