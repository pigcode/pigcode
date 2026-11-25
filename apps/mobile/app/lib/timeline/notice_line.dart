import 'package:flutter/material.dart';

import '../theme_colors.dart';
import 'timeline_tokens.dart';

enum TimelineNoticeLevel { info, warning, error }

/// 轮外可见的一行提示（桌面 `.turn-notice`）：
/// padding 6/12、r8、13/1.5、Info 12px 图标；按级别区分底色（info 用 `--cv-inline-code`、
/// warning 用 `--warn-soft`、error 用 `--bad-soft`）。
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
      TimelineNoticeLevel.info => colors.timelineInlineCode,
      TimelineNoticeLevel.warning => colors.attentionTint,
      TimelineNoticeLevel.error => colors.errorTint,
    };
    final foreground = switch (level) {
      TimelineNoticeLevel.info => colors.timelineSubtle,
      TimelineNoticeLevel.warning => colors.attention,
      TimelineNoticeLevel.error => colors.error,
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
            padding: const EdgeInsets.only(top: TimelineSpace.x1),
            child: Icon(
              Icons.info_outline,
              size: TimelineIcon.badge,
              color: foreground,
            ),
          ),
          const SizedBox(width: TimelineSpace.fieldGap),
          Expanded(
            child: Text(
              text,
              style: TimelineType.metaStyle(
                foreground,
                height: TimelineType.noticeHeight,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 失败轮的错误块（桌面 `.turn-error`）：8/12 内衬、r8、`10% --cv-removed` 底、
/// AlertTriangle 12px 图标、15/1.5 正文。
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
        color: colors.timelineRemoved.withValues(
          alpha: TimelineToolCard.errorTintAlpha,
        ),
        borderRadius: BorderRadius.circular(TimelineRadius.block),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: TimelineSpace.x2),
            child: Icon(
              Icons.warning_amber_rounded,
              size: TimelineIcon.badge,
              color: colors.error,
            ),
          ),
          const SizedBox(width: TimelineSpace.fieldGap),
          Expanded(
            child: Text(
              text,
              style: TimelineType.contentStyle(
                colors.error,
                height: TimelineType.noticeHeight,
              ),
            ),
          ),
        ],
      ),
    );
  }
}
