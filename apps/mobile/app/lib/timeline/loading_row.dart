import 'dart:async';

import 'package:flutter/material.dart';

import '../mobile_status_dot.dart';
import '../theme_colors.dart';
import 'shimmer_text.dart';
import 'timeline_tokens.dart';

/// 运行中接在轮末的一行（桌面 `.turn-loading`）：
/// 15px 图标槽内 10×10 3×3 点阵（8 帧 1.4s）、4s 扫光「工作中」、13px 等宽耗时（`formatDuration`）；
/// 排队时写「排队中」、不扫光、不计时。
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

class _TimelineLoadingRowState extends State<TimelineLoadingRow> {
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
      _clock = Timer.periodic(TimelineMotion.tick, (_) {
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
  void dispose() {
    _clock?.cancel();
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
    final labelStyle = TimelineType.contentStyle(colors.timelineSubtle);

    return Semantics(
      label: label,
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
          const SizedBox(width: TimelineSpace.fieldGap),
          if (widget.queued)
            Text(label, style: labelStyle)
          else
            TimelineShimmerText(text: label, style: labelStyle),
          if (step != null && step.isNotEmpty) ...[
            const SizedBox(width: TimelineSpace.fieldGap),
            Flexible(
              child: Text(
                step,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TimelineType.contentStyle(colors.timelineFaint),
              ),
            ),
          ],
          if (!widget.queued && widget.startedAt != null) ...[
            const SizedBox(width: TimelineSpace.fieldGap),
            Text(
              formatTimelineDuration(_elapsed),
              style: TimelineType.metaMonoStyle(colors.timelineSubtle),
            ),
          ],
          if (plan != null) ...[
            const SizedBox(width: TimelineSpace.fieldGap),
            Text(
              '计划 $plan',
              style: TimelineType.metaStyle(colors.timelineFaint),
            ),
          ],
        ],
      ),
    );
  }
}
