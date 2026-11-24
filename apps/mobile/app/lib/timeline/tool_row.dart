import 'package:flutter/material.dart';

import '../theme_colors.dart';
import 'timeline_tokens.dart';

/// 工具行公共外壳：图标、动作、对象、改动行数、状态词和展开箭头。
class TimelineToolRow extends StatelessWidget {
  const TimelineToolRow({
    super.key,
    required this.icon,
    required this.action,
    this.detail,
    this.diff,
    this.status,
    this.running = false,
    this.failed = false,
    this.detailFaint = false,
    this.hideDetailWhenExpanded = false,
    this.onStatusTap,
    this.showIcon = true,
    this.expandable = false,
    this.expanded = false,
    this.onTap,
    this.child,
  });

  final IconData icon;
  final String action;
  final String? detail;
  final ({int added, int removed})? diff;
  final String? status;
  final bool running;
  final bool failed;
  final bool detailFaint;
  final bool hideDetailWhenExpanded;
  final VoidCallback? onStatusTap;
  final bool showIcon;
  final bool expandable;
  final bool expanded;
  final VoidCallback? onTap;
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final actionColor = failed ? colors.error : colors.timelineSubtle;
    final detailColor = failed
        ? colors.error
        : detailFaint
        ? colors.timelineFaint
        : colors.foreground;
    final statusColor = failed ? colors.error : colors.timelineFaint;
    final touch = timelineTouchHeight(context);

    final row = Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        if (showIcon) ...[
          SizedBox(
            width: TimelineIcon.row,
            height: TimelineIcon.row,
            child: Icon(
              icon,
              size: TimelineIcon.row,
              color: failed ? colors.error : colors.timelineSubtle,
            ),
          ),
          const SizedBox(width: TimelineSpace.x4),
        ] else
          const SizedBox(width: TimelineIcon.row + TimelineSpace.x4),
        Expanded(
          child: Text.rich(
            TextSpan(
              children: [
                TextSpan(text: action),
                if (detail != null &&
                    detail!.isNotEmpty &&
                    !(expanded && hideDetailWhenExpanded)) ...[
                  const TextSpan(text: ' '),
                  TextSpan(
                    text: detail,
                    style: TextStyle(color: detailColor),
                  ),
                ],
                if (diff != null && (diff!.added > 0 || diff!.removed > 0)) ...[
                  const TextSpan(text: ' '),
                  if (diff!.added > 0)
                    TextSpan(
                      text: '+${diff!.added}',
                      style: TextStyle(color: colors.diffAdded),
                    ),
                  if (diff!.added > 0 && diff!.removed > 0)
                    const TextSpan(text: ' '),
                  if (diff!.removed > 0)
                    TextSpan(
                      text: '-${diff!.removed}',
                      style: TextStyle(color: colors.diffRemoved),
                    ),
                ],
              ],
            ),
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TimelineType.contentStyle(actionColor),
          ),
        ),
        if (status != null) ...[
          const SizedBox(width: TimelineSpace.x4),
          if (onStatusTap != null && failed)
            InkWell(
              onTap: onStatusTap,
              borderRadius: BorderRadius.circular(TimelineRadius.small),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Text(
                  status!,
                  style: TimelineType.metaStyle(statusColor).copyWith(
                    decoration: TextDecoration.underline,
                    decorationStyle: TextDecorationStyle.dotted,
                    decorationColor: statusColor,
                  ),
                ),
              ),
            )
          else
            Text(
              status!,
              style: TimelineType.metaStyle(statusColor).copyWith(
                decoration: failed ? TextDecoration.underline : null,
                decorationStyle: TextDecorationStyle.dotted,
                decorationColor: statusColor,
              ),
            ),
        ],
        if (expandable) ...[
          const SizedBox(width: TimelineSpace.x2),
          Icon(
            expanded ? Icons.keyboard_arrow_down : Icons.keyboard_arrow_right,
            size: TimelineIcon.control,
            color: colors.timelineFaint,
          ),
        ],
      ],
    );

    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (expandable || onTap != null)
          Semantics(
            button: expandable,
            expanded: expandable ? expanded : null,
            child: InkWell(
              onTap: onTap,
              child: ConstrainedBox(
                constraints: BoxConstraints(minHeight: touch),
                child: Align(
                  alignment: AlignmentDirectional.centerStart,
                  heightFactor: 1,
                  child: row,
                ),
              ),
            ),
          )
        else
          ConstrainedBox(
            constraints: BoxConstraints(minHeight: touch),
            child: Align(
              alignment: AlignmentDirectional.centerStart,
              heightFactor: 1,
              child: row,
            ),
          ),
        if (expanded && child != null)
          Padding(
            padding: const EdgeInsetsDirectional.only(
              start: TimelineIcon.row + TimelineSpace.x4,
              top: TimelineSpace.x2,
              bottom: TimelineSpace.x2,
            ),
            child: child,
          ),
      ],
    );
    return body;
  }
}

/// 展开后的工具详情块：浅底、圆角、等宽正文，过长的内容在内部滚动。
class TimelineToolDetails extends StatelessWidget {
  const TimelineToolDetails({
    super.key,
    required this.children,
    this.padding = const EdgeInsets.all(TimelineSpace.x5),
  });

  final List<Widget> children;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: colors.surfaceSunken,
        borderRadius: BorderRadius.circular(TimelineRadius.block),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final (index, child) in children.indexed) ...[
            if (index > 0) const SizedBox(height: TimelineSpace.x4),
            child,
          ],
        ],
      ),
    );
  }
}

/// 详情块里的一个小节：标题 + 等宽正文。
class TimelineToolSection extends StatelessWidget {
  const TimelineToolSection({
    super.key,
    required this.label,
    required this.text,
    this.maxHeight = 240,
    this.color,
    this.prefix,
  });

  final String label;
  final String text;
  final double maxHeight;
  final Color? color;
  final String? prefix;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final body = Text.rich(
      TextSpan(
        children: [
          if (prefix != null)
            TextSpan(
              text: '$prefix ',
              style: TextStyle(color: colors.timelineFaint),
            ),
          TextSpan(text: text),
        ],
      ),
      style: TimelineType.codeStyle(color ?? colors.foreground),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TimelineType.smallStyle(colors.timelineFaint)),
        const SizedBox(height: TimelineSpace.x2),
        ConstrainedBox(
          constraints: BoxConstraints(maxHeight: maxHeight),
          child: SingleChildScrollView(child: body),
        ),
      ],
    );
  }
}
