import 'package:flutter/material.dart';

import '../theme_colors.dart';
import 'timeline_tokens.dart';

enum TimelineNoticeLevel { info, warning, error }

/// 轮外可见的一行提示：MCP 未接上、Host 重启、审批结果等。
class TimelineNoticeLine extends StatelessWidget {
  const TimelineNoticeLine({
    super.key,
    required this.text,
    this.level = TimelineNoticeLevel.warning,
  });

  final String text;
  final TimelineNoticeLevel level;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final background = switch (level) {
      TimelineNoticeLevel.info => colors.panel,
      TimelineNoticeLevel.warning => colors.attentionTint,
      TimelineNoticeLevel.error => colors.errorTint,
    };
    final foreground = switch (level) {
      TimelineNoticeLevel.info => colors.timelineSubtle,
      TimelineNoticeLevel.warning => colors.attention,
      TimelineNoticeLevel.error => colors.error,
    };
    final icon = switch (level) {
      TimelineNoticeLevel.info => Icons.info_outline,
      TimelineNoticeLevel.warning => Icons.warning_amber_rounded,
      TimelineNoticeLevel.error => Icons.error_outline,
    };
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: TimelineSpace.x6,
        vertical: TimelineSpace.x3,
      ),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(TimelineRadius.block),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(icon, size: TimelineIcon.meta, color: foreground),
          ),
          const SizedBox(width: TimelineSpace.x4),
          Expanded(
            child: Text(text, style: TimelineType.metaStyle(foreground)),
          ),
        ],
      ),
    );
  }
}

/// 失败轮的错误块：错误浅底 + 左图标。
class TimelineErrorBlock extends StatelessWidget {
  const TimelineErrorBlock({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(
        horizontal: TimelineSpace.x6,
        vertical: TimelineSpace.x4,
      ),
      decoration: BoxDecoration(
        color: colors.errorTint,
        borderRadius: BorderRadius.circular(TimelineRadius.block),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 3),
            child: Icon(
              Icons.error_outline,
              size: TimelineIcon.meta,
              color: colors.error,
            ),
          ),
          const SizedBox(width: TimelineSpace.x4),
          Expanded(
            child: Text(
              text,
              style: TimelineType.contentStyle(
                colors.error,
              ).copyWith(height: 1.5),
            ),
          ),
        ],
      ),
    );
  }
}
