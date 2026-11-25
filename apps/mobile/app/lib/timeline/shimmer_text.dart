import 'package:flutter/material.dart';

import '../theme_colors.dart';
import 'timeline_tokens.dart';

/// 桌面 `.tool-shimmer` 的手机实现：4s 周期，前半程一道 22% 前景色的浅光从右向左扫过，后半程静止。
/// 减少动效或未激活时直接显示静态文本。
class TimelineShimmerText extends StatefulWidget {
  const TimelineShimmerText({
    super.key,
    required this.text,
    required this.style,
    this.active = true,
    this.maxLines,
    this.overflow,
  });

  final String text;
  final TextStyle style;
  final bool active;
  final int? maxLines;
  final TextOverflow? overflow;

  @override
  State<TimelineShimmerText> createState() => _TimelineShimmerTextState();
}

class _TimelineShimmerTextState extends State<TimelineShimmerText>
    with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(
    vsync: this,
    duration: TimelineMotion.shimmer,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(TimelineShimmerText oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.active != widget.active) _sync();
  }

  void _sync() {
    final reduced = MediaQuery.disableAnimationsOf(context);
    final visible = TickerMode.valuesOf(context).enabled;
    if (!widget.active || reduced || !visible) {
      _controller.stop();
      _controller.value = 0;
    } else if (!_controller.isAnimating) {
      _controller.repeat();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final reduced = MediaQuery.disableAnimationsOf(context);
    if (!widget.active) {
      return Text(
        widget.text,
        maxLines: widget.maxLines,
        overflow: widget.overflow,
        style: widget.style,
      );
    }
    // 桌面 `@media (prefers-reduced-motion: reduce)` 下 `.tool-shimmer` 退回正文前景色。
    final baseText = Text(
      widget.text,
      maxLines: widget.maxLines,
      overflow: widget.overflow,
      style: widget.style.copyWith(color: colors.foreground),
    );
    if (reduced) return baseText;
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, child) {
        // 前 50% 从右向左扫过（position 100% -> 0%），后 50% 停留在 0%。
        final sweep = (_controller.value * 2).clamp(0.0, 1.0);
        // 300% 宽度渐变在 [0..1] 视窗中移动：光带中心从 +1.5 滑到 -0.5。
        final center = 1.5 - 2.0 * sweep;
        const halfBand = 0.48;
        return ShaderMask(
          blendMode: BlendMode.srcIn,
          shaderCallback: (bounds) => LinearGradient(
            begin: Alignment(center - halfBand, 0),
            end: Alignment(center + halfBand, 0),
            colors: [
              colors.foreground,
              colors.timelineShimmerSoft,
              colors.foreground,
            ],
            stops: const [0, 0.5, 1],
          ).createShader(bounds),
          child: child,
        );
      },
      child: baseText,
    );
  }
}
