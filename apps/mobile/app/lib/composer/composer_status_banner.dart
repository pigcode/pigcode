import 'package:flutter/material.dart';

import '../timeline/timeline_tokens.dart';
import 'composer_tokens.dart';

enum ComposerStatusTone { neutral, attention, success, error }

/// 输入框卡片顶部的紧凑状态提示条（发送确认、待查回执、回执找回、轻量报错），
/// 统一用于会话回复框与新会话草稿框。
class ComposerStatusBanner extends StatelessWidget {
  const ComposerStatusBanner({
    super.key,
    required this.title,
    this.tone = ComposerStatusTone.neutral,
    this.loading = false,
    this.icon,
    this.detail,
    this.trailing,
    this.actions = const [],
  });

  final String title;
  final ComposerStatusTone tone;
  final bool loading;
  final IconData? icon;
  final Widget? detail;
  final Widget? trailing;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final dark = brightness == Brightness.dark;
    final colors = ComposerSurface.palette(brightness);

    final (background, border, iconColor, titleColor) = switch (tone) {
      ComposerStatusTone.neutral => (
        colors.field,
        colors.divider,
        colors.muted,
        colors.muted,
      ),
      ComposerStatusTone.attention => (
        colors.attentionMark.withValues(alpha: dark ? 0.14 : 0.10),
        colors.attention.withValues(alpha: dark ? 0.28 : 0.18),
        colors.attention,
        colors.attention,
      ),
      ComposerStatusTone.success => (
        colors.readyMark.withValues(alpha: dark ? 0.14 : 0.09),
        colors.readyMark.withValues(alpha: dark ? 0.28 : 0.22),
        colors.readyMark,
        colors.secondaryText,
      ),
      ComposerStatusTone.error => (
        colors.error.withValues(alpha: dark ? 0.14 : 0.08),
        colors.error.withValues(alpha: dark ? 0.28 : 0.18),
        colors.error,
        colors.error,
      ),
    };

    final resolvedIcon =
        icon ??
        switch (tone) {
          ComposerStatusTone.neutral => Icons.info_outline_rounded,
          ComposerStatusTone.attention => Icons.schedule_rounded,
          ComposerStatusTone.success => Icons.check_circle_outline_rounded,
          ComposerStatusTone.error => Icons.error_outline_rounded,
        };
    final compact = detail == null && actions.isEmpty;

    return DecoratedBox(
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(ComposerRadius.panel),
        border: Border.all(color: border, width: ComposerBorder.hairline),
      ),
      child: Padding(
        padding: EdgeInsets.symmetric(
          horizontal: TimelineSpace.x5,
          vertical: compact ? TimelineSpace.x3 : TimelineSpace.x4,
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              spacing: TimelineSpace.x3,
              children: [
                if (loading)
                  SizedBox.square(
                    dimension: TimelineIcon.btn,
                    child: CircularProgressIndicator(
                      strokeWidth: ComposerBorder.indicator,
                      color: iconColor,
                      value: MediaQuery.disableAnimationsOf(context)
                          ? 0.72
                          : null,
                    ),
                  )
                else
                  Icon(resolvedIcon, size: TimelineIcon.meta, color: iconColor),
                Expanded(
                  child: Semantics(
                    liveRegion: true,
                    child: Text(
                      title,
                      style: TimelineType.smallStyle(
                        titleColor,
                        weight: FontWeight.w500,
                      ),
                    ),
                  ),
                ),
                ?trailing,
              ],
            ),
            if (detail case final detailWidget?) ...[
              const SizedBox(height: TimelineSpace.x2),
              detailWidget,
            ],
            if (actions.isNotEmpty) ...[
              const SizedBox(height: TimelineSpace.x3),
              Wrap(
                spacing: TimelineSpace.x3,
                runSpacing: TimelineSpace.x2,
                children: actions,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// 状态条里的紧凑动作按钮，避免默认 Material TextButton 占满 48px 造成卡片膨胀。
class ComposerBannerAction extends StatelessWidget {
  const ComposerBannerAction({
    super.key,
    required this.label,
    required this.onPressed,
    this.emphasized = false,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool emphasized;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final enabled = onPressed != null;
    final foreground = emphasized ? colors.foreground : colors.secondaryText;
    final background = emphasized ? colors.surfaceRaised : Colors.transparent;
    final border = emphasized ? colors.strongBorder : colors.border;

    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        visualDensity: VisualDensity.compact,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        minimumSize: const Size(0, TimelineControl.md),
        padding: const EdgeInsets.symmetric(
          horizontal: TimelineSpace.x5,
          vertical: TimelineSpace.x2,
        ),
        foregroundColor: foreground,
        disabledForegroundColor: colors.faint,
        backgroundColor: background,
        disabledBackgroundColor: Colors.transparent,
        side: BorderSide(
          color: enabled ? border : colors.divider,
          width: ComposerBorder.hairline,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(ComposerRadius.block),
        ),
        textStyle: TimelineType.smallStyle(foreground, weight: FontWeight.w500),
      ),
      child: Text(label),
    );
  }
}
