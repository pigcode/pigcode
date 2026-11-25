import 'package:flutter/material.dart';

import '../theme_colors.dart';
import 'shimmer_text.dart';
import 'timeline_tokens.dart';

enum TimelineDetailTone { primary, secondary, tertiary }

/// 工具行公共外壳（桌面 `.tool-row`）：图标、动作、对象、改动行数、状态词和展开箭头。
/// 在摘要组内部（`showIcon == false`）不占图标宽度，文字紧贴左导线（8 + 16 = 24px）对齐。
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
    this.detailTone = TimelineDetailTone.primary,
    this.hideDetailWhenExpanded = false,
    this.onStatusTap,
    this.showIcon = true,
    this.compact = false,
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
  final TimelineDetailTone detailTone;
  final bool hideDetailWhenExpanded;
  final VoidCallback? onStatusTap;
  final bool showIcon;
  final bool compact;
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
        : switch (detailTone) {
            TimelineDetailTone.primary => colors.foreground,
            TimelineDetailTone.secondary => colors.timelineSubtle,
            TimelineDetailTone.tertiary => colors.timelineFaint,
          };
    final statusColor = failed ? colors.error : colors.timelineSubtle;
    final showDetail =
        detail != null &&
        detail!.isNotEmpty &&
        !(expanded && hideDetailWhenExpanded);
    final showDiff = diff != null && (diff!.added > 0 || diff!.removed > 0);
    final actionStyle = TimelineType.contentStyle(actionColor);

    final row = Row(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        if (showIcon) ...[
          SizedBox(
            width: TimelineIcon.row,
            height: TimelineIcon.row,
            child: Center(
              child: Icon(
                icon,
                size: TimelineIcon.row,
                color: failed ? colors.error : colors.timelineSubtle,
              ),
            ),
          ),
          const SizedBox(width: TimelineSpace.fieldGap),
        ],
        Flexible(
          child: Row(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              if (running && !failed)
                TimelineShimmerText(text: action, style: actionStyle)
              else
                Text(action, style: actionStyle),
              if (showDetail) ...[
                const SizedBox(width: TimelineSpace.fieldGap),
                Flexible(
                  child: Text(
                    detail!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.contentStyle(detailColor),
                  ),
                ),
              ],
              if (showDiff) ...[
                const SizedBox(width: TimelineSpace.fieldGap),
                if (diff!.added > 0)
                  Text(
                    '+${diff!.added}',
                    style: TimelineType.diffCountStyle(colors.diffAdded),
                  ),
                if (diff!.added > 0 && diff!.removed > 0)
                  const SizedBox(width: TimelineSpace.x2),
                if (diff!.removed > 0)
                  Text(
                    '-${diff!.removed}',
                    style: TimelineType.diffCountStyle(colors.diffRemoved),
                  ),
              ],
            ],
          ),
        ),
        if (status != null) ...[
          const SizedBox(width: TimelineSpace.fieldGap),
          if (onStatusTap != null && failed)
            InkWell(
              onTap: onStatusTap,
              borderRadius: BorderRadius.circular(TimelineRadius.small),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: TimelineSpace.x2),
                child: Text(
                  status!,
                  style: TimelineType.contentStyle(statusColor).copyWith(
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
              style: TimelineType.contentStyle(statusColor).copyWith(
                decoration: failed ? TextDecoration.underline : null,
                decorationStyle: TextDecorationStyle.dotted,
                decorationColor: statusColor,
              ),
            ),
        ],
        if (expandable) ...[
          const SizedBox(width: TimelineSpace.fieldGap),
          AnimatedRotation(
            turns: expanded ? 0.25 : 0,
            duration: MediaQuery.disableAnimationsOf(context)
                ? Duration.zero
                : TimelineMotion.slow,
            curve: TimelineMotion.ease,
            child: Icon(
              Icons.chevron_right,
              size: TimelineIcon.badge,
              color: colors.timelineFaint,
            ),
          ),
        ],
      ],
    );

    final minHeight = compact ? 0.0 : timelineTouchHeight(context);
    final header = ConstrainedBox(
      constraints: BoxConstraints(minHeight: minHeight),
      child: Align(
        alignment: AlignmentDirectional.centerStart,
        heightFactor: 1,
        child: compact
            ? Padding(
                padding: const EdgeInsets.symmetric(vertical: TimelineSpace.x1),
                child: row,
              )
            : row,
      ),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (expandable || onTap != null)
          Semantics(
            button: expandable,
            expanded: expandable ? expanded : null,
            child: InkWell(
              onTap: onTap,
              borderRadius: BorderRadius.circular(TimelineRadius.xs),
              child: header,
            ),
          )
        else
          header,
        if (expanded && child != null)
          Padding(
            padding: const EdgeInsets.only(top: TimelineSpace.x4),
            child: child,
          ),
      ],
    );
  }
}

/// 展开后的工具详情卡（桌面 `.tool-card`）：1px 边、r12、`--cv-panel` 底、12/16 内衬、12 间距。
class TimelineToolDetails extends StatelessWidget {
  const TimelineToolDetails({
    super.key,
    required this.children,
    this.padding = TimelineToolCard.padding,
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
      margin: const EdgeInsets.only(bottom: TimelineSpace.x4),
      padding: padding,
      decoration: BoxDecoration(
        color: colors.timelinePanel,
        border: Border.all(
          color: colors.timelineBorder,
          width: TimelineBorder.regular,
        ),
        borderRadius: BorderRadius.circular(TimelineToolCard.radius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final (index, child) in children.indexed) ...[
            if (index > 0) const SizedBox(height: TimelineToolCard.gap),
            child,
          ],
        ],
      ),
    );
  }
}

/// 详情卡里的小节（桌面 `.tool-card-field.is-block` + `.tool-card-pre`）：标题 + 等宽正文。
class TimelineToolSection extends StatelessWidget {
  const TimelineToolSection({
    super.key,
    required this.label,
    required this.text,
    this.maxHeight = TimelineToolCard.sectionMaxHeight,
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
      style: TimelineType.codeStyle(color ?? colors.timelineSubtle),
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: TimelineType.metaStyle(colors.timelineSubtle)),
        const SizedBox(height: TimelineSpace.x2),
        Container(
          width: double.infinity,
          padding: TimelineToolCard.padding,
          decoration: BoxDecoration(
            color: colors.field,
            borderRadius: BorderRadius.circular(TimelineRadius.panel),
          ),
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxHeight),
            child: SingleChildScrollView(child: body),
          ),
        ),
      ],
    );
  }
}
