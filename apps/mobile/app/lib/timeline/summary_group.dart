import 'package:flutter/material.dart';

import '../theme_colors.dart';
import '../timeline_work.dart';
import 'timeline_tokens.dart';

IconData timelineSummaryIcon(TimelineToolKind? kind) => switch (kind) {
  TimelineToolKind.read ||
  TimelineToolKind.search ||
  TimelineToolKind.fetch => Icons.search,
  TimelineToolKind.edit => Icons.edit_outlined,
  TimelineToolKind.command => Icons.terminal,
  TimelineToolKind.browser => Icons.language,
  TimelineToolKind.mcp => Icons.hub_outlined,
  TimelineToolKind.skill => Icons.auto_awesome_outlined,
  TimelineToolKind.task => Icons.task_alt_outlined,
  TimelineToolKind.plan => Icons.checklist_rounded,
  TimelineToolKind.ask => Icons.help_outline,
  TimelineToolKind.other || null => Icons.auto_awesome_outlined,
};

/// 连续摘要组的行：统计、只改文件时的文件 chip、展开箭头。
class TimelineSummaryGroupRow extends StatelessWidget {
  const TimelineSummaryGroupRow({
    super.key,
    required this.label,
    required this.icon,
    required this.files,
    required this.expanded,
    required this.toggleable,
    this.onToggle,
  });

  final String label;
  final TimelineToolKind? icon;
  final List<String> files;
  final bool expanded;
  final bool toggleable;
  final VoidCallback? onToggle;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final row = Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 3),
          child: SizedBox(
            width: TimelineIcon.row,
            height: TimelineIcon.row,
            child: Icon(
              timelineSummaryIcon(icon),
              size: TimelineIcon.row,
              color: colors.timelineSubtle,
            ),
          ),
        ),
        const SizedBox(width: TimelineSpace.x4),
        Expanded(
          child: Wrap(
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: TimelineSpace.x2,
            runSpacing: TimelineSpace.x1,
            children: [
              Text(
                label,
                style: TimelineType.contentStyle(colors.timelineSubtle),
              ),
              for (final path in files.take(3)) _FileChip(path: path),
              if (files.length > 3)
                Text(
                  '+${files.length - 3}',
                  style: TimelineType.smallStyle(colors.timelineFaint),
                ),
            ],
          ),
        ),
        if (toggleable)
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Icon(
              expanded ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_right,
              size: TimelineIcon.control,
              color: colors.timelineFaint,
            ),
          ),
      ],
    );
    final hit = timelineTouchHeight(context);
    if (!toggleable) {
      return ConstrainedBox(
        constraints: BoxConstraints(minHeight: hit),
        child: Align(
          alignment: AlignmentDirectional.topStart,
          heightFactor: 1,
          child: row,
        ),
      );
    }
    return Semantics(
      button: true,
      expanded: expanded,
      child: InkWell(
        onTap: onToggle,
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: hit),
          child: Align(
            alignment: AlignmentDirectional.topStart,
            heightFactor: 1,
            child: row,
          ),
        ),
      ),
    );
  }
}

class _FileChip extends StatelessWidget {
  const _FileChip({required this.path});

  final String path;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final name = path.split('/').last;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          Icons.insert_drive_file_outlined,
          size: TimelineIcon.badge,
          color: colors.timelineFile,
        ),
        const SizedBox(width: TimelineSpace.x1),
        Text(name, style: TimelineType.smallStyle(colors.timelineFile)),
      ],
    );
  }
}
