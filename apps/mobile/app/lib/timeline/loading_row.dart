import 'dart:async';

import 'package:flutter/material.dart';

import '../mobile_status_dot.dart';
import '../theme_colors.dart';
import 'timeline_tokens.dart';

/// 运行中接在轮末的一行：3×3 点阵、「工作中」扫光、等宽计时；排队时写「排队中」且不计时。
class TimelineLoadingRow extends StatefulWidget {
  const TimelineLoadingRow({
    super.key,
    this.startedAt,
    this.queued = false,
    this.step,
    this.finishedSteps,
    this.totalSteps,
  });

  final DateTime? startedAt;
  final bool queued;
  final String? step;
  final int? finishedSteps;
  final int? totalSteps;

  @override
  State<TimelineLoadingRow> createState() => _TimelineLoadingRowState();
}

class _TimelineLoadingRowState extends State<TimelineLoadingRow>
    with SingleTickerProviderStateMixin {
  late final _shimmer = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 4),
  );
  Timer? _clock;
  Duration _elapsed = Duration.zero;

  @override
  void initState() {
    super.initState();
    _start();
  }

  @override
  void didUpdateWidget(TimelineLoadingRow oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.startedAt != widget.startedAt ||
        oldWidget.queued != widget.queued) {
      _start();
    }
  }

  void _start() {
    _clock?.cancel();
    _elapsed = _elapsedFor(widget.startedAt);
    if (!widget.queued && widget.startedAt != null) {
      _clock = Timer.periodic(const Duration(seconds: 1), (_) {
        if (!mounted) return;
        setState(() => _elapsed = _elapsedFor(widget.startedAt));
      });
    }
  }

  Duration _elapsedFor(DateTime? start) {
    if (start == null) return Duration.zero;
    final value = DateTime.now().difference(start.toLocal());
    return value.isNegative ? Duration.zero : value;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    if (reduceMotion) {
      _shimmer.stop();
      _shimmer.value = .5;
    } else if (!_shimmer.isAnimating) {
      _shimmer.repeat();
    }
  }

  @override
  void dispose() {
    _clock?.cancel();
    _shimmer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final label = widget.queued ? '排队中' : '工作中';
    final step = widget.step?.trim();
    final plan = widget.totalSteps != null && widget.totalSteps! > 0
        ? '${widget.finishedSteps ?? 0}/${widget.totalSteps}'
        : null;
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final text = Text(
      label,
      style: TimelineType.contentStyle(colors.timelineSubtle),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: TimelineSpace.x2),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SizedBox(
            width: TimelineIcon.row,
            height: TimelineIcon.row,
            child: Center(
              child: MobileRunningDotMatrix(color: colors.secondaryText),
            ),
          ),
          const SizedBox(width: TimelineSpace.x4),
          if (reduceMotion)
            text
          else
            AnimatedBuilder(
              animation: _shimmer,
              builder: (context, child) => ShaderMask(
                blendMode: BlendMode.srcIn,
                shaderCallback: (bounds) => LinearGradient(
                  begin: Alignment(-1.4 + 2.8 * _shimmer.value, 0),
                  end: Alignment(-0.4 + 2.8 * _shimmer.value, 0),
                  colors: [
                    colors.timelineSubtle,
                    colors.foreground,
                    colors.timelineSubtle,
                  ],
                  stops: const [0, .5, 1],
                ).createShader(bounds),
                child: child,
              ),
              child: text,
            ),
          if (step != null && step.isNotEmpty) ...[
            const SizedBox(width: TimelineSpace.x4),
            Flexible(
              child: Text(
                step,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TimelineType.contentStyle(colors.timelineFaint),
              ),
            ),
          ],
          if (!widget.queued) ...[
            const SizedBox(width: TimelineSpace.x4),
            Text(
              _formatElapsed(_elapsed),
              style: TimelineType.codeStyle(
                colors.timelineFaint,
              ).copyWith(fontFeatures: const [FontFeature.tabularFigures()]),
            ),
          ],
          if (plan != null) ...[
            const SizedBox(width: TimelineSpace.x4),
            Text(
              '计划 $plan',
              style: TimelineType.smallStyle(colors.timelineFaint),
            ),
          ],
        ],
      ),
    );
  }

  String _formatElapsed(Duration value) {
    final minutes = value.inMinutes;
    final seconds = value.inSeconds.remainder(60);
    return '$minutes:${seconds.toString().padLeft(2, '0')}';
  }
}
