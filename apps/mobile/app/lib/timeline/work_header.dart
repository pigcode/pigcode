import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../theme_colors.dart';
import '../workspace_icon.dart';
import 'timeline_tokens.dart';

/// 工作区折叠头的文案：正常结束「用时 N 秒」，被停止「已停止」，没有时间「已处理」。
String timelineWorkLabel(TimelineTurn turn) {
  if (turn.status == TimelineTurnStatus.interrupted) return '已停止';
  final start = DateTime.tryParse(turn.startedAt);
  final end = DateTime.tryParse(turn.terminal?.createdAt ?? '');
  if (start == null || end == null) return '已处理';
  var remaining = (end.difference(start).inMilliseconds / 1000).round().clamp(
    1,
    9999999,
  );
  final parts = <String>[];
  for (final (size, unit) in const [
    (86400, '天'),
    (3600, '时'),
    (60, '分'),
    (1, '秒'),
  ]) {
    final value = remaining ~/ size;
    remaining %= size;
    if (value > 0) parts.add('$value $unit');
    if (parts.length == 2) break;
  }
  return '用时 ${parts.join(' ')}';
}

/// 结束轮的工作折叠头：次级文字、底部细线、箭头旋转 90°。
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
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final line = DecoratedBox(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: colors.timelineDivider)),
      ),
      child: Padding(
        padding: const EdgeInsets.only(bottom: 9),
        child: Row(
          children: [
            Flexible(
              child: Text(
                timelineWorkLabel(turn),
                style: TimelineType.contentStyle(
                  colors.timelineSubtle,
                ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
              ),
            ),
            if (canToggle) ...[
              const SizedBox(width: TimelineSpace.x4),
              IconTheme(
                data: IconThemeData(color: colors.timelineSubtle),
                child: RotatedBox(
                  quarterTurns: open ? 0 : 3,
                  child: const WorkspaceIcon(
                    WorkspaceGlyph.chevronDown,
                    size: TimelineIcon.control,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
    if (!canToggle) {
      return Padding(
        padding: const EdgeInsets.only(bottom: TimelineSpace.x6),
        child: line,
      );
    }
    final hit = timelineTouchHeight(context);
    return Semantics(
      expanded: open,
      button: true,
      child: InkWell(
        key: ValueKey('fold-${turn.key}'),
        onTap: onToggle,
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: hit),
          child: Align(
            alignment: Alignment.topLeft,
            heightFactor: 1,
            child: line,
          ),
        ),
      ),
    );
  }
}
